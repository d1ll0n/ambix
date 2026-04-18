// src/compact-session/condense-input.ts
//
// Per-tool condensation of a tool_use.input into a structured, truncation-aware
// field list. The bundled-mode XML renderer consumes this to emit one
// `<tool_use>` element with distinct child elements per field — verbatim for
// small/scalar values, `truncated="<bytes>"` attribute + preview body for
// oversized strings.
//
// Why per-tool: a generic JSON dump would put raw `[COMPACTION STUB …]` strings
// inside fields an agent might pattern-match, and would lose the "this is
// structured" framing. Per-tool handlers know which fields are truncatable
// (Edit old/new_string, Write content, Task prompt, …) and which are always
// small (file_path, offset, command description, …).
//
// PRESERVE_TOOLS (Task*): CC replays these tool_uses to rebuild task state on
// resume. Inputs pass through verbatim regardless of size.

import type { ToolResultBlock } from "parse-cc";
import { condenseToolUse } from "../brief/condensers.js";
import { type PreserveSelector, matchesToolSelector } from "./preserve-selector.js";
import { PRESERVE_TOOLS } from "./preserve-tools.js";

/** One field inside a condensed tool_use.input. */
export type CondensedField =
  | { name: string; kind: "verbatim"; value: unknown }
  | { name: string; kind: "truncated"; preview: string; origBytes: number };

export interface CondensedToolInput {
  /** Per-field breakdown for `<tool_use>` XML rendering. */
  fields: CondensedField[];
  /**
   * One-liner summary of the tool_use + tool_result pair (stats, diff counts,
   * etc.). Renderer emits this as the `<tool_result>` body — stats belong on
   * the result semantically, not duplicated on the use.
   */
  resultSummary: string;
}

export interface CondenseInputOpts {
  /** UTF-8 byte threshold above which a truncatable field becomes a preview. */
  maxFieldBytes: number;
  /** Number of chars of the original kept as a preview (0 = marker-only). */
  previewChars: number;
  /**
   * User-supplied `--preserve tool:<glob>` selectors. If a tool name matches
   * any, ALL of its input fields pass through verbatim (no truncation) —
   * same branch PRESERVE_TOOLS takes for Task*. Defaults to no matching.
   */
  userPreserveSelectors?: ReadonlyArray<PreserveSelector>;
}

/** Top-level dispatcher. Picks a per-tool handler or falls back to generic. */
export function condenseToolInput(
  name: string,
  input: unknown,
  result: ToolResultBlock | null,
  opts: CondenseInputOpts
): CondensedToolInput {
  const inp = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const resultSummary = condenseToolUse(name, input, result);

  // PRESERVE_TOOLS: pass every field through verbatim. CC reads these on
  // resume to rebuild task state; we MUST NOT redact anything.
  if (PRESERVE_TOOLS.has(name)) {
    return { fields: allVerbatim(inp), resultSummary };
  }

  // User `--preserve tool:<glob>` selectors: same verbatim treatment, but
  // only triggered by explicit user opt-in. Used for tools that carry
  // primary user-visible content (e.g. an MCP telegram plugin whose
  // tool_use inputs ARE the messages between user + agent).
  if (opts.userPreserveSelectors && matchesToolSelector(name, opts.userPreserveSelectors)) {
    return { fields: allVerbatim(inp), resultSummary };
  }

  const fields = dispatch(name, inp, opts);
  return { fields, resultSummary };
}

// ---------------------------------------------------------------------------
// Per-tool handlers
// ---------------------------------------------------------------------------

function dispatch(
  name: string,
  inp: Record<string, unknown>,
  opts: CondenseInputOpts
): CondensedField[] {
  if (name === "Read") return fieldsForRead(inp);
  if (name === "Edit" || name === "NotebookEdit") return fieldsForEdit(inp, opts);
  if (name === "MultiEdit") return fieldsForMultiEdit(inp, opts);
  if (name === "Write") return fieldsForWrite(inp, opts);
  if (name === "Bash") return fieldsForBash(inp, opts);
  if (name === "Grep") return fieldsForGrep(inp);
  if (name === "Glob") return fieldsForGlob(inp);
  if (name === "Task" || name === "Agent") return fieldsForTask(inp, opts);
  if (name === "TodoWrite") return fieldsForTodoWrite(inp);
  return fieldsForGeneric(inp, opts);
}

function fieldsForRead(inp: Record<string, unknown>): CondensedField[] {
  return pickVerbatim(inp, ["file_path", "offset", "limit", "pages"]);
}

function fieldsForEdit(inp: Record<string, unknown>, opts: CondenseInputOpts): CondensedField[] {
  return [
    ...pickVerbatim(inp, ["file_path", "replace_all"]),
    ...pickTruncatable(inp, ["old_string", "new_string"], opts),
  ];
}

function fieldsForMultiEdit(
  inp: Record<string, unknown>,
  opts: CondenseInputOpts
): CondensedField[] {
  // `edits` is an array of {old_string, new_string} — size-sweep the whole
  // array together via JSON. Individual big strings inside get truncated
  // with a generic marker by walking the value. (Pretty-printing each edit
  // as nested XML is nicer but adds a lot of renderer complexity for a
  // tool used rarely enough that the JSON form is acceptable v1.)
  const out = pickVerbatim(inp, ["file_path"]);
  const edits = inp.edits;
  if (edits !== undefined) {
    const condensed = condenseDeepByField(edits, opts);
    out.push({ name: "edits", kind: "verbatim", value: condensed });
  }
  return out;
}

function fieldsForWrite(inp: Record<string, unknown>, opts: CondenseInputOpts): CondensedField[] {
  return [...pickVerbatim(inp, ["file_path"]), ...pickTruncatable(inp, ["content"], opts)];
}

function fieldsForBash(inp: Record<string, unknown>, opts: CondenseInputOpts): CondensedField[] {
  return [
    ...pickTruncatable(inp, ["command"], opts),
    ...pickVerbatim(inp, ["description", "timeout", "run_in_background"]),
  ];
}

function fieldsForGrep(inp: Record<string, unknown>): CondensedField[] {
  return pickVerbatim(inp, [
    "pattern",
    "path",
    "glob",
    "type",
    "output_mode",
    "-n",
    "-i",
    "-A",
    "-B",
    "-C",
    "context",
    "head_limit",
    "offset",
    "multiline",
  ]);
}

function fieldsForGlob(inp: Record<string, unknown>): CondensedField[] {
  return pickVerbatim(inp, ["pattern", "path"]);
}

function fieldsForTask(inp: Record<string, unknown>, opts: CondenseInputOpts): CondensedField[] {
  return [
    ...pickVerbatim(inp, [
      "subagent_type",
      "description",
      "model",
      "isolation",
      "run_in_background",
    ]),
    ...pickTruncatable(inp, ["prompt"], opts),
  ];
}

function fieldsForTodoWrite(inp: Record<string, unknown>): CondensedField[] {
  // TodoWrite.todos is an array of small objects ({content, status, activeForm});
  // each row is rarely more than ~200 bytes. Pass through verbatim — if an
  // individual todo somehow exceeds the threshold, the renderer's sanity
  // clamp will catch it.
  return pickVerbatim(inp, ["todos"]);
}

/**
 * Generic handler for unknown / MCP tools. Walks the input at top level:
 * scalar values pass through verbatim; string values over the threshold
 * become truncated; nested objects / arrays are JSON-serialized and
 * size-swept so individual oversized strings within them are replaced.
 */
function fieldsForGeneric(inp: Record<string, unknown>, opts: CondenseInputOpts): CondensedField[] {
  const out: CondensedField[] = [];
  for (const [key, raw] of Object.entries(inp)) {
    if (typeof raw === "string") {
      out.push(stringField(key, raw, opts));
      continue;
    }
    if (raw === null || raw === undefined || typeof raw !== "object") {
      out.push({ name: key, kind: "verbatim", value: raw });
      continue;
    }
    // Object / array: deep-sweep any oversized leaf strings.
    out.push({ name: key, kind: "verbatim", value: condenseDeepByField(raw, opts) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pickVerbatim(inp: Record<string, unknown>, keys: string[]): CondensedField[] {
  const out: CondensedField[] = [];
  for (const k of keys) {
    if (k in inp && inp[k] !== undefined) {
      out.push({ name: k, kind: "verbatim", value: inp[k] });
    }
  }
  return out;
}

function pickTruncatable(
  inp: Record<string, unknown>,
  keys: string[],
  opts: CondenseInputOpts
): CondensedField[] {
  const out: CondensedField[] = [];
  for (const k of keys) {
    const v = inp[k];
    if (v === undefined) continue;
    if (typeof v === "string") {
      out.push(stringField(k, v, opts));
    } else {
      out.push({ name: k, kind: "verbatim", value: v });
    }
  }
  return out;
}

function stringField(name: string, value: string, opts: CondenseInputOpts): CondensedField {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes <= opts.maxFieldBytes) {
    return { name, kind: "verbatim", value };
  }
  const preview = opts.previewChars > 0 ? value.slice(0, opts.previewChars) : "";
  return { name, kind: "truncated", preview, origBytes: bytes };
}

function allVerbatim(inp: Record<string, unknown>): CondensedField[] {
  return Object.entries(inp).map(([name, value]) => ({ name, kind: "verbatim", value }));
}

/**
 * Recursively walk an object/array and replace any string leaf whose UTF-8
 * length exceeds the threshold with a compact marker string. The returned
 * value is structurally the same as the input but with oversized string
 * leaves replaced by `[truncated: <N> bytes]` sentinels.
 *
 * Used by the generic + MultiEdit handlers for nested structures where we
 * haven't defined per-field truncation semantics. String sentinels are
 * consistent within the parse — they'll carry through to JSON-rendering in
 * the XML body without leaking the `[COMPACTION STUB …]` failure-prone
 * pattern into tool_use.input.
 */
function condenseDeepByField(value: unknown, opts: CondenseInputOpts): unknown {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes <= opts.maxFieldBytes) return value;
    const preview = opts.previewChars > 0 ? `${value.slice(0, opts.previewChars)}…` : "";
    return `[truncated: ${bytes} bytes${preview ? `; preview: ${preview}` : ""}]`;
  }
  if (Array.isArray(value)) {
    return value.map((v) => condenseDeepByField(v, opts));
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      out[k] = condenseDeepByField(v, opts);
    }
    return out;
  }
  return value;
}
