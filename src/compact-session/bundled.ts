// src/compact-session/bundled.ts
//
// Bundled-mode emitter for `ambix compact`.
//
// Layout on disk:
//
//   [ONE user-role entry containing <ambix-compaction-marker> + per-turn XML
//    summary of every condensed source entry]
//   [Task* entries from the condensed range, preserved VERBATIM so CC can
//    replay them to rebuild its live task list on resume]
//   [preserved tail — the last `fullRecent` rounds of the source, verbatim]
//
// Why this shape:
//   - A single user-role message is a known-safe carrier for free-form text;
//     CC's context assembly does not trim it the way it trims older
//     structural entries.
//   - Collapsing every non-preserved entry into prose means shape-specific
//     bloat (MCP tools with large payloads, unknown fields) can't leak —
//     the prose renderer sees every field and truncates by size.
//   - Per-tool structured XML (via condense-input + render-bundled-xml)
//     keeps information parity with raw tool_use.input while framing the
//     content as clearly a summary, not a transcript the agent could
//     pattern-match back into a new tool call.
//   - Task* entries pass through as real entries because CC reconstructs
//     task state by replaying them on resume. See preserve-tools.ts.

import { randomUUID } from "node:crypto";
import type { LogEntry, ToolResultBlock } from "parse-cc";
import {
  isAssistantEntry,
  isFileHistorySnapshotEntry,
  isTextBlock,
  isToolResultBlock,
  isToolUseBlock,
  isUserEntry,
} from "parse-cc";
import { groupIntoRounds } from "../brief/rounds.js";
import { type CondensedToolInput, condenseToolInput } from "./condense-input.js";
import { rewritePreservedEntry } from "./emit-shared.js";
import { shouldPreserveTool } from "./preserve-tools.js";
import { renderToolResultXml, renderToolUseXml } from "./render-bundled-xml.js";
import { DEFAULT_MAX_FIELD_BYTES, DEFAULT_PREVIEW_CHARS } from "./tuning.js";
import type { CompactSessionStats } from "./types.js";

/**
 * Sanity clamp for user/assistant text blocks. Conversational text should
 * pass through verbatim by default (structural parity), but an individual
 * text block that's truly unreasonable (e.g. an embedded base64 blob
 * somehow) should still get truncation treatment. Set high enough that
 * natural human + agent prose always passes.
 */
const TEXT_BLOCK_SANITY_CAP_BYTES = 16 * 1024;

export interface EmitBundledOptions {
  sourceEntries: ReadonlyArray<LogEntry>;
  newSessionId: string;
  origSessionId: string;
  fullRecent: number;
  cwd: string;
  gitBranch: string;
  version: string;
  /** Override every per-entry uuid (deterministic tests). Default: randomUUID. */
  uuidFn?: () => string;
  /** Timestamp for the single bundled user-message. Default: new Date().toISOString(). */
  bundledTimestamp?: string;
  /** Override for the bundled user-message's uuid (deterministic tests). */
  bundledUuid?: string;
  /** Override for the bundled user-message's promptId (deterministic tests). */
  bundledPromptId?: string;
  /** Stub command prefix override. Default `"ambix query"`. */
  ambixCmd?: string;
  /** UTF-8 byte threshold for in-prose tool_use field truncation. */
  maxFieldBytes?: number;
  /** Preview chars kept in front of the truncation marker. */
  previewChars?: number;
}

export interface EmitBundledResult {
  entries: ReadonlyArray<Record<string, unknown>>;
  stats: CompactSessionStats;
}

export function emitBundled(opts: EmitBundledOptions): EmitBundledResult {
  const entries = opts.sourceEntries;
  const preservedFirstIx = computePreservedFirstIx(entries, opts.fullRecent);
  const uuidFn = opts.uuidFn ?? randomUUID;
  const ambixCmd = opts.ambixCmd ?? "ambix query";
  const maxFieldBytes = opts.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
  const previewChars = opts.previewChars ?? DEFAULT_PREVIEW_CHARS;

  // Index tool_use by id so we can render `<tool_result>` with the correct
  // tool name (the result block itself only carries tool_use_id).
  const toolUseById = buildToolUseIndex(entries);

  const stats: CompactSessionStats = {
    sourceEntryCount: entries.length,
    condensedEntryCount: 0,
    preservedEntryCount: 0,
    droppedEntryCount: 0,
    stubbedToolResultCount: 0,
    truncatedInputFieldCount: 0,
    bytesSaved: 0,
    bundledTurnCount: 0,
    mixedPreservedEntryCount: 0,
  };

  // Pass 1: walk the condensed range, building the prose turn list AND
  // the list of Task* entries to pass through verbatim.
  const turnXmlLines: string[] = [];
  const taskThroughputSources: LogEntry[] = [];
  const condenseOpts = { maxFieldBytes, previewChars };

  for (let ix = 0; ix < preservedFirstIx; ix++) {
    const src = entries[ix];

    if (isFileHistorySnapshotEntry(src)) {
      stats.droppedEntryCount += 1;
      stats.bytesSaved += Buffer.byteLength(JSON.stringify(src), "utf8");
      continue;
    }

    const cls = classifyForBundling(src, toolUseById);
    if (cls.preserve) {
      taskThroughputSources.push(src);
      if (cls.mixed) stats.mixedPreservedEntryCount += 1;
      continue;
    }

    const xml = renderTurn(src, ix, {
      toolUseById,
      origSessionId: opts.origSessionId,
      ambixCmd,
      condenseOpts,
      stats,
    });
    if (xml !== null) {
      turnXmlLines.push(xml);
      stats.bundledTurnCount += 1;
    }
  }

  const bundledContent = buildBundledContent({
    origSessionId: opts.origSessionId,
    preservedFirstIx,
    lastSourceIx: entries.length - 1,
    fullRecent: opts.fullRecent,
    hasPreservedTools: taskThroughputSources.length > 0,
    turnXmlLines,
    ambixCmd,
  });

  const emitted: Record<string, unknown>[] = [];
  let prevUuid: string | null = null;

  const bundledEntry = buildBundledEntry({
    uuid: opts.bundledUuid ?? uuidFn(),
    promptId: opts.bundledPromptId ?? uuidFn(),
    sessionId: opts.newSessionId,
    parentUuid: null,
    cwd: opts.cwd,
    gitBranch: opts.gitBranch,
    version: opts.version,
    timestamp: opts.bundledTimestamp ?? new Date().toISOString(),
    content: bundledContent,
  });
  emitted.push(bundledEntry);
  prevUuid = bundledEntry.uuid as string;

  for (const src of taskThroughputSources) {
    const rewritten = rewritePreservedEntry({
      source: src,
      newUuid: uuidFn(),
      newSessionId: opts.newSessionId,
      parentUuid: prevUuid,
    });
    emitted.push(rewritten.entry);
    if (rewritten.hasUuid) prevUuid = rewritten.entry.uuid as string;
  }

  for (let ix = preservedFirstIx; ix < entries.length; ix++) {
    const src = entries[ix];
    const rewritten = rewritePreservedEntry({
      source: src,
      newUuid: uuidFn(),
      newSessionId: opts.newSessionId,
      parentUuid: prevUuid,
    });
    emitted.push(rewritten.entry);
    if (rewritten.hasUuid) prevUuid = rewritten.entry.uuid as string;
    stats.preservedEntryCount += 1;
  }

  return { entries: emitted, stats };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface ToolUseInfo {
  name: string;
  input: unknown;
}

function buildToolUseIndex(entries: ReadonlyArray<LogEntry>): Map<string, ToolUseInfo> {
  const map = new Map<string, ToolUseInfo>();
  for (const e of entries) {
    if (!isAssistantEntry(e)) continue;
    for (const block of e.message.content) {
      if (isToolUseBlock(block)) {
        map.set(block.id, { name: block.name, input: block.input });
      }
    }
  }
  return map;
}

/**
 * Classify an entry for bundled-mode dispatch. Task* payloads pass through
 * verbatim so CC can replay them on resume; mixed entries (Task* + other
 * blocks) are preserved whole and tracked via mixedPreservedEntryCount.
 */
function classifyForBundling(
  src: LogEntry,
  toolUseById: Map<string, ToolUseInfo>
): { preserve: boolean; mixed: boolean } {
  if (isAssistantEntry(src)) {
    let hasPreserved = false;
    let hasOther = false;
    for (const block of src.message.content) {
      if (isToolUseBlock(block)) {
        if (shouldPreserveTool(block.name)) hasPreserved = true;
        else hasOther = true;
      }
      // text blocks are conversational, not a "mixed" signal
    }
    return { preserve: hasPreserved, mixed: hasPreserved && hasOther };
  }
  if (isUserEntry(src)) {
    const content = src.message.content;
    if (!Array.isArray(content)) return { preserve: false, mixed: false };
    let hasPreserved = false;
    let hasOther = false;
    for (const block of content) {
      if (isToolResultBlock(block)) {
        const info = toolUseById.get(block.tool_use_id);
        if (info && shouldPreserveTool(info.name)) hasPreserved = true;
        else hasOther = true;
      } else if (isTextBlock(block)) {
        hasOther = true;
      }
    }
    return { preserve: hasPreserved, mixed: hasPreserved && hasOther };
  }
  return { preserve: false, mixed: false };
}

interface TurnContext {
  toolUseById: Map<string, ToolUseInfo>;
  origSessionId: string;
  ambixCmd: string;
  condenseOpts: { maxFieldBytes: number; previewChars: number };
  stats: CompactSessionStats;
}

function renderTurn(src: LogEntry, ix: number, ctx: TurnContext): string | null {
  if (isAssistantEntry(src)) return renderAssistantTurn(src, ix, ctx);
  if (isUserEntry(src)) return renderUserTurn(src, ix, ctx);
  // system / summary / unknown — skip; original reachable via `ambix query`.
  return null;
}

function renderAssistantTurn(
  src: Extract<LogEntry, { type: "assistant" }>,
  ix: number,
  ctx: TurnContext
): string {
  const parts: string[] = [];
  for (const block of src.message.content) {
    if (isTextBlock(block)) {
      if (typeof block.text === "string") {
        parts.push(renderTextBlock(block.text, ix, ctx));
      }
    } else if (isToolUseBlock(block)) {
      const condensed = condenseToolInput(block.name, block.input, null, ctx.condenseOpts);
      recordToolUseStats(condensed, block.input, ctx.stats);
      parts.push(renderToolUseXml(block, ix, condensed));
    }
    // thinking / image — skip
  }
  const body = parts.length ? parts.join("\n") : "(empty)";
  return `<turn ix="${ix}" kind="assistant">\n${body}\n</turn>`;
}

function renderUserTurn(
  src: Extract<LogEntry, { type: "user" }>,
  ix: number,
  ctx: TurnContext
): string {
  const content = src.message.content;

  if (typeof content === "string") {
    return `<turn ix="${ix}" kind="user">\n${renderTextBlock(content, ix, ctx)}\n</turn>`;
  }
  if (!Array.isArray(content)) {
    return `<turn ix="${ix}" kind="user"/>`;
  }

  const textParts: string[] = [];
  const toolResultParts: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      if (typeof block.text === "string") textParts.push(renderTextBlock(block.text, ix, ctx));
    } else if (isToolResultBlock(block)) {
      toolResultParts.push(renderToolResultPart(block, ix, ctx));
    }
  }

  if (toolResultParts.length === 0 && textParts.length > 0) {
    return `<turn ix="${ix}" kind="user">\n${textParts.join("\n")}\n</turn>`;
  }
  if (toolResultParts.length > 0 && textParts.length === 0) {
    return `<turn ix="${ix}" kind="tool_result">\n${toolResultParts.join("\n")}\n</turn>`;
  }
  const combined = [...textParts, ...toolResultParts].join("\n");
  return `<turn ix="${ix}" kind="user">\n${combined}\n</turn>`;
}

/**
 * Render a user or assistant text block. Conversational text is preserved
 * verbatim (no cap) unless it exceeds a generous sanity threshold — in
 * which case we emit a `<truncated_text>` element with preview body and a
 * `bytes` attribute so the shape is distinguishable from CC's harness
 * display truncation.
 */
function renderTextBlock(text: string, ix: number, ctx: TurnContext): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= TEXT_BLOCK_SANITY_CAP_BYTES) {
    return escapeXmlText(text);
  }
  ctx.stats.truncatedInputFieldCount += 1;
  const preview =
    ctx.condenseOpts.previewChars > 0 ? text.slice(0, ctx.condenseOpts.previewChars) : "";
  const body = preview ? `${escapeXmlText(preview)}…` : "";
  const tag = `<truncated_text bytes="${bytes}" ix="${ix}">${body}</truncated_text>`;
  ctx.stats.bytesSaved += Math.max(0, bytes - Buffer.byteLength(tag, "utf8"));
  return tag;
}

function renderToolResultPart(block: ToolResultBlock, ix: number, ctx: TurnContext): string {
  const use = ctx.toolUseById.get(block.tool_use_id);
  const name = use?.name ?? "unknown";
  const condensed = condenseToolInput(name, use?.input ?? {}, block, ctx.condenseOpts);
  ctx.stats.stubbedToolResultCount += 1;
  const rawLen = rawToolResultBytes(block);
  const rendered = renderToolResultXml(block, ix, name, condensed.resultSummary);
  ctx.stats.bytesSaved += Math.max(0, rawLen - Buffer.byteLength(rendered, "utf8"));
  return rendered;
}

function recordToolUseStats(
  condensed: CondensedToolInput,
  originalInput: unknown,
  stats: CompactSessionStats
): void {
  for (const field of condensed.fields) {
    if (field.kind === "truncated") {
      stats.truncatedInputFieldCount += 1;
    }
  }
  if (originalInput === null || originalInput === undefined) return;
  const origBytes = Buffer.byteLength(JSON.stringify(originalInput), "utf8");
  // The per-field rendering's post-bytes are hard to predict cheaply here;
  // approximate by counting only the sum of replaced field sizes. Fine for
  // a stats counter that's advisory, not authoritative.
  let saved = 0;
  for (const field of condensed.fields) {
    if (field.kind === "truncated") {
      saved += Math.max(0, field.origBytes - field.preview.length - 32 /* tag overhead */);
    }
  }
  if (saved > 0) stats.bytesSaved += Math.min(saved, origBytes);
}

function rawToolResultBytes(block: ToolResultBlock): number {
  if (typeof block.content === "string") return Buffer.byteLength(block.content, "utf8");
  if (Array.isArray(block.content)) return Buffer.byteLength(JSON.stringify(block.content), "utf8");
  return 0;
}

// ---------------------------------------------------------------------------
// Preamble + bundled-entry construction
// ---------------------------------------------------------------------------

function buildBundledContent(args: {
  origSessionId: string;
  preservedFirstIx: number;
  lastSourceIx: number;
  fullRecent: number;
  hasPreservedTools: boolean;
  turnXmlLines: string[];
  ambixCmd: string;
}): string {
  const preamble: string[] = [
    "<ambix-compaction-marker>",
    `This session was compacted by ambix from ${args.origSessionId}.`,
    "",
  ];
  if (args.preservedFirstIx > 0) {
    preamble.push(
      `Turns 0–${args.preservedFirstIx - 1} were condensed into the \`<turns>\` block below.`,
      `Each \`<turn ix="N">\` summarizes ONE source entry. To retrieve the original content`,
      `of turn N, run: \`${args.ambixCmd} ${args.origSessionId} N\` (substitute the ix).`,
      "",
      "Condensed tool_use inputs use per-tool XML with `<field>value</field>` children.",
      `Fields marked \`truncated="<bytes>"\` carry a short preview ending in \`…\` followed`,
      "by the original byte count — the real value is rehydratable via the command above.",
      ""
    );
  }
  if (args.hasPreservedTools) {
    preamble.push(
      "Task-management tool calls (TaskCreate / TaskUpdate / …) are preserved verbatim as real entries immediately after this message. This lets CC rebuild its live task list on resume.",
      ""
    );
  }
  if (args.preservedFirstIx <= args.lastSourceIx) {
    preamble.push(
      `Source turns ${args.preservedFirstIx}–${args.lastSourceIx} are preserved verbatim as real entries at the end of this session (the last ${args.fullRecent} round${args.fullRecent === 1 ? "" : "s"} of the source conversation).`,
      ""
    );
  }
  preamble.push(
    "Do NOT infer or guess what a condensed turn contained — the XML here is a structured summary, not the real tool invocation. Run the rehydration command when you need actual content.",
    "",
    "Continue the conversation from where it left off.",
    "</ambix-compaction-marker>",
    ""
  );

  if (args.turnXmlLines.length === 0) {
    return preamble.join("\n");
  }
  const turns = ["<turns>", ...args.turnXmlLines, "</turns>"].join("\n");
  return `${preamble.join("\n")}${turns}\n`;
}

function buildBundledEntry(args: {
  uuid: string;
  promptId: string;
  sessionId: string;
  parentUuid: string | null;
  cwd: string;
  gitBranch: string;
  version: string;
  timestamp: string;
  content: string;
}): Record<string, unknown> {
  return {
    parentUuid: args.parentUuid,
    isSidechain: false,
    promptId: args.promptId,
    userType: "external",
    isMeta: false,
    type: "user",
    message: { role: "user", content: args.content },
    uuid: args.uuid,
    timestamp: args.timestamp,
    sessionId: args.sessionId,
    version: args.version,
    gitBranch: args.gitBranch,
    cwd: args.cwd,
  };
}

/**
 * Find the ix where the preserved tail begins. Reuses brief/groupIntoRounds
 * so structural and bundled modes draw the boundary at the same place.
 */
function computePreservedFirstIx(entries: ReadonlyArray<LogEntry>, fullRecent: number): number {
  if (fullRecent <= 0 || entries.length === 0) return entries.length;
  const indexed = entries.map((entry, ix) => ({ entry, ix }));
  const rounds = groupIntoRounds(indexed);
  if (rounds.length === 0) return entries.length;
  const pickIdx = Math.max(0, rounds.length - fullRecent);
  return rounds[pickIdx].userIx;
}

// ---------------------------------------------------------------------------
// XML escaping (for text-block bodies in the <turns> wrapper). Strips XML
// 1.0-illegal code points + escapes reserved chars.
// ---------------------------------------------------------------------------

const XML_ILLEGAL_RE = new RegExp(
  [
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]",
    "[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])",
    "(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]",
  ].join("|"),
  "g"
);

function stripIllegalControl(s: string): string {
  return s.replace(XML_ILLEGAL_RE, "");
}

function escapeXmlText(s: string): string {
  return stripIllegalControl(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
