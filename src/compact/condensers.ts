// src/compact/condensers.ts
//
// Per-tool "one-liner" renderers used by `alembic compact`. Each takes
// a tool_use's input plus its (optional) tool_result and returns a
// short human-readable summary. The goal is to preserve the intent of
// each call (what file, what command, how big the output was) without
// carrying the full payloads.

import type { ToolResultBlock } from "parse-claude-logs";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Rough token estimate — chars/4 matches alembic's other token math. */
export function estTokens(s: string): number {
  return Math.round(s.length / 4);
}

/** Truncate `s` to at most `n` visible chars, replacing newlines with ⏎. */
export function shorten(s: string, n = 80): string {
  const flat = s.replace(/\n/g, " ⏎ ");
  if (flat.length <= n) return flat;
  return `${flat.slice(0, n - 1)}…`;
}

// Strip the first two directory components from paths that start with
// common absolute prefixes (home dirs, tmp, etc.) so the output stays
// readable. Leaves uncommon roots like /var/log/... untouched.
const ABS_PREFIX_RE = /^\/(root|home|tmp|Users|users)\/[^/]+\/(.+)$/;

/** Strip common long absolute prefixes so paths are readable. */
export function fmtPath(p: string | undefined | null): string {
  if (!p) return "<no path>";
  const m = ABS_PREFIX_RE.exec(p);
  if (m) return m[2];
  return p;
}

/** Flatten a tool_result content value into a single string. */
export function toolResultText(block: ToolResultBlock | null): string {
  if (!block) return "";
  const c = block.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const parts: string[] = [];
    for (const inner of c) {
      if (inner && typeof inner === "object") {
        const rec = inner as { text?: unknown; content?: unknown };
        if (typeof rec.text === "string") parts.push(rec.text);
        else if (typeof rec.content === "string") parts.push(rec.content);
      }
    }
    return parts.join("\n");
  }
  return c === null || c === undefined ? "" : JSON.stringify(c);
}

export function isToolResultError(block: ToolResultBlock | null): boolean {
  return !!block?.is_error;
}

// ---------------------------------------------------------------------------
// Diff stat for Edit
// ---------------------------------------------------------------------------

/**
 * Approximate `+added -deleted` counts for an Edit tool_use.
 *
 * Uses common-prefix / common-suffix stripping on line arrays. This
 * matches the most common shape of Edit (old_string = exact block
 * being replaced, new_string = exact replacement) and gives accurate
 * stats for typical single-hunk edits. For multi-region edits inside
 * one call it over-counts, which is fine as a top-line signal.
 */
export function diffStat(oldStr: string, newStr: string): { added: number; deleted: number } {
  const oldLines = oldStr.split("\n");
  const newLines = newStr.split("\n");
  let i = 0;
  while (i < oldLines.length && i < newLines.length && oldLines[i] === newLines[i]) i++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > i && newEnd > i && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { deleted: oldEnd - i, added: newEnd - i };
}

// ---------------------------------------------------------------------------
// Git commit extraction (from Bash tool_result text)
// ---------------------------------------------------------------------------

// Matches the first line emitted by `git commit`:
//   [branch-name shortHash] subject
//   [branch-name shortHash (root-commit)] subject
const GIT_COMMIT_RE = /^\[(\S+)\s+([a-f0-9]{7,40})(?:\s*\([^)]+\))?\]\s*(.*?)$/m;

export function extractCommit(
  result: ToolResultBlock | null
): { shortHash: string; subject: string } | null {
  if (!result) return null;
  const text = toolResultText(result);
  if (!text) return null;
  const m = GIT_COMMIT_RE.exec(text);
  if (!m) return null;
  return { shortHash: m[2].slice(0, 7), subject: m[3].trim() };
}

// ---------------------------------------------------------------------------
// Per-tool condensers
// ---------------------------------------------------------------------------

type Input = Record<string, unknown>;

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function condenseRead(input: Input, result: ToolResultBlock | null): string {
  const path = fmtPath(asString(input.file_path));
  const offset = input.offset;
  const limit = input.limit;
  const text = toolResultText(result);
  // Claude's Read tool emits cat -n style output; strip the "  N\t" prefix
  // for a fair token estimate of the actual file content.
  const contentOnly = text.replace(/^\s*\d+\s*\t/gm, "");
  const lines =
    text.length === 0
      ? 0
      : text.split("\n").filter((l, i, a) => i < a.length - 1 || l.length > 0).length;
  const tokens = estTokens(contentOnly);
  const window =
    offset !== undefined || limit !== undefined
      ? ` (offset=${offset ?? 0}, limit=${limit ?? "?"})`
      : "";
  if (isToolResultError(result)) {
    const firstErr = text.split("\n", 1)[0].slice(0, 80);
    return `Read ${path}${window} → [error: ${firstErr}]`;
  }
  return `Read ${path}${window} — ${lines} lines, ~${tokens} tokens`;
}

export function condenseEdit(input: Input, result: ToolResultBlock | null): string {
  const path = fmtPath(asString(input.file_path));
  const oldStr = asString(input.old_string);
  const newStr = asString(input.new_string);
  const { added, deleted } = diffStat(oldStr, newStr);
  const replaceAll = input.replace_all === true;
  const suffix = replaceAll ? " (replace_all)" : "";
  if (isToolResultError(result)) {
    const firstErr = toolResultText(result).split("\n", 1)[0].slice(0, 80);
    return `Edit ${path} → [error: ${firstErr}]`;
  }
  return `Edit ${path}${suffix} +${added} -${deleted}`;
}

export function condenseWrite(input: Input, result: ToolResultBlock | null): string {
  const path = fmtPath(asString(input.file_path));
  const content = asString(input.content);
  const lines = content.length === 0 ? 0 : content.split("\n").length;
  const tokens = estTokens(content);
  if (isToolResultError(result)) {
    const firstErr = toolResultText(result).split("\n", 1)[0].slice(0, 80);
    return `Write ${path} → [error: ${firstErr}]`;
  }
  return `Write ${path} — ${lines} lines, ~${tokens} tokens`;
}

export function condenseGrep(input: Input, result: ToolResultBlock | null): string {
  const pattern = asString(input.pattern);
  const path = asString(input.path) || asString(input.glob);
  const scope = path ? ` in ${fmtPath(path)}` : "";
  const text = toolResultText(result);
  let count: number;
  const m = text.match(/Found (\d+) (?:file|match|line)/);
  if (m) count = Number.parseInt(m[1], 10);
  else count = text.split("\n").filter((l) => l.trim().length > 0).length;
  if (isToolResultError(result)) {
    return `Grep ${JSON.stringify(shorten(pattern, 50))}${scope} → [error]`;
  }
  return `Grep ${JSON.stringify(shorten(pattern, 50))}${scope} — ${count} matches`;
}

export function condenseGlob(input: Input, result: ToolResultBlock | null): string {
  const pattern = asString(input.pattern);
  const text = toolResultText(result);
  const count = text.split("\n").filter((l) => l.trim().length > 0).length;
  if (isToolResultError(result)) {
    return `Glob ${JSON.stringify(shorten(pattern, 60))} → [error]`;
  }
  return `Glob ${JSON.stringify(shorten(pattern, 60))} — ${count} matches`;
}

export function condenseBash(input: Input, result: ToolResultBlock | null): string {
  const cmd = asString(input.command);
  const description = asString(input.description);
  const text = toolResultText(result);
  const size = estTokens(text);
  const status = isToolResultError(result) ? "[error]" : "";
  const head = shorten(cmd, 70);
  const desc = description && description.length < 40 ? ` (${description})` : "";
  const commit = !isToolResultError(result) ? extractCommit(result) : null;
  const commitSuffix = commit
    ? ` → commit ${commit.shortHash} ${JSON.stringify(shorten(commit.subject, 50))}`
    : "";
  return `Bash \`${head}\`${desc} — ~${size} tok out ${status}${commitSuffix}`.trimEnd();
}

export function condenseTask(input: Input, result: ToolResultBlock | null): string {
  const sub = asString(input.subagent_type) || "?";
  const desc = asString(input.description);
  const prompt = asString(input.prompt);
  const head = shorten(desc || prompt, 70);
  if (isToolResultError(result)) {
    return `Task → ${sub}: ${JSON.stringify(head)} → [error]`;
  }
  const resultTokens = estTokens(toolResultText(result));
  return `Task → ${sub}: ${JSON.stringify(head)} — returned ~${resultTokens} tok`;
}

export function condenseTodoOrTaskOps(name: string, input: Input): string {
  const subject = asString(input.subject) || asString(input.description) || asString(input.title);
  const tid = asString(input.taskId) || asString(input.id);
  const status = asString(input.status);
  const bits: string[] = [];
  if (tid) bits.push(`#${tid}`);
  if (subject) bits.push(shorten(subject, 70));
  if (status) bits.push(`[${status}]`);
  return `${name} ${bits.join(" ")}`.trimEnd();
}

export function condensePlaywright(
  name: string,
  input: Input,
  result: ToolResultBlock | null
): string {
  const shortName = name.replace(/^mcp__plugin_playwright_playwright__/, "");
  const keyFields = ["url", "element", "ref", "text", "key", "selector"];
  let chosen: string | null = null;
  for (const k of keyFields) {
    const v = input[k];
    if (typeof v === "string") {
      chosen = `${k}=${JSON.stringify(shorten(v, 40))}`;
      break;
    }
  }
  if (!chosen) {
    for (const k of Object.keys(input)) {
      const v = input[k];
      if (typeof v === "string") {
        chosen = `${k}=${JSON.stringify(shorten(v, 40))}`;
        break;
      }
    }
  }
  const args = chosen ?? "";
  if (isToolResultError(result)) return `${shortName}(${args}) → [error]`;
  return `${shortName}(${args})`;
}

export function condenseGeneric(
  name: string,
  input: Input,
  result: ToolResultBlock | null
): string {
  let hint = "";
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      hint = ` ${k}=${JSON.stringify(shorten(String(v), 40))}`;
      break;
    }
  }
  const status = isToolResultError(result) ? " [error]" : "";
  return `${name}${hint}${status}`;
}

/** Dispatch to the right per-tool condenser. */
export function condenseToolUse(
  name: string,
  input: unknown,
  result: ToolResultBlock | null
): string {
  const inp = (input && typeof input === "object" ? input : {}) as Input;
  if (name === "Read") return condenseRead(inp, result);
  if (name === "Edit" || name === "NotebookEdit") return condenseEdit(inp, result);
  if (name === "Write") return condenseWrite(inp, result);
  if (name === "Grep") return condenseGrep(inp, result);
  if (name === "Glob") return condenseGlob(inp, result);
  if (name === "Bash") return condenseBash(inp, result);
  if (name === "Task" || name === "Agent") return condenseTask(inp, result);
  if (
    name === "TodoWrite" ||
    name === "TaskCreate" ||
    name === "TaskUpdate" ||
    name === "TaskList" ||
    name === "TaskGet"
  ) {
    return condenseTodoOrTaskOps(name, inp);
  }
  if (name.startsWith("mcp__plugin_playwright_playwright__")) {
    return condensePlaywright(name, inp, result);
  }
  return condenseGeneric(name, inp, result);
}
