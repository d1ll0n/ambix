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
//   - Task* entries are the one exception because CC reconstructs task
//     state by replaying them on resume; collapsing them to prose would
//     silently drop the task list. See src/compact-session/preserve-tools.ts.

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
import { condenseToolUse, toolResultText } from "../brief/condensers.js";
import { groupIntoRounds } from "../brief/rounds.js";
import { rewritePreservedEntry } from "./emit-shared.js";
import { shouldPreserveTool } from "./preserve-tools.js";
import { DEFAULT_MAX_FIELD_BYTES, DEFAULT_PREVIEW_CHARS } from "./tuning.js";
import type { CompactSessionStats } from "./types.js";

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
  /** UTF-8 byte threshold for in-prose text-block truncation. */
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

  // Index tool_use → { name, input } for rendering tool_result turns
  // (we need the tool name to pick a condenser for the result).
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

  for (let ix = 0; ix < preservedFirstIx; ix++) {
    const src = entries[ix];

    // Drop file-history-snapshot: CC never feeds these to the model.
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
      maxFieldBytes,
      previewChars,
      stats,
    });
    if (xml !== null) {
      turnXmlLines.push(xml);
      stats.bundledTurnCount += 1;
    }
  }

  // Build the single bundled user-message.
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

  // Pass-through Task* entries from the condensed range. Rewrite uuid and
  // parentUuid chain but leave everything else verbatim — CC needs the
  // Task*Create / TaskUpdate payloads unaltered to reconstruct task state.
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

  // Preserved tail — verbatim.
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
 * Classify an entry for bundled-mode dispatch. We preserve entries whole
 * when they carry a Task* payload CC needs to replay on resume; otherwise
 * they go into the bundled summary.
 *
 * "Mixed" entries — those that pair a Task* block with non-Task content in
 * the same entry — are preserved whole (can't safely split a single entry
 * across the bundle/post-bundle boundary without breaking CC's parentUuid
 * expectations). The non-Task content slips through verbatim; callers get
 * a `mixedPreservedEntryCount` stat so we can detect and fix if it
 * becomes a real source of bloat in practice.
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
      } else if (isTextBlock(block)) {
        // Text adjacent to a Task* tool_use is expected and conversational;
        // only count OTHER tool_use blocks as a mixed signal.
      }
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
        // Plain text in a user tool_result entry is unusual; treat as other
        // so mixed-entry reporting flags it for inspection.
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
  maxFieldBytes: number;
  previewChars: number;
  stats: CompactSessionStats;
}

function renderTurn(src: LogEntry, ix: number, ctx: TurnContext): string | null {
  if (isAssistantEntry(src)) return renderAssistantTurn(src, ix, ctx);
  if (isUserEntry(src)) return renderUserTurn(src, ix, ctx);
  // system / summary / unknown — skip; these rarely carry agent-relevant
  // context and the original file is still reachable via ambix query.
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
      if (typeof block.text === "string") parts.push(shrinkText(block.text, ix, ctx));
    } else if (isToolUseBlock(block)) {
      const summary = condenseToolUse(block.name, block.input, null);
      parts.push(
        `<tool_use name="${escapeXmlAttr(block.name)}">${escapeXmlText(summary)}</tool_use>`
      );
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

  // Simple string content — plain user text.
  if (typeof content === "string") {
    return `<turn ix="${ix}" kind="user">\n${shrinkText(content, ix, ctx)}\n</turn>`;
  }
  if (!Array.isArray(content)) {
    return `<turn ix="${ix}" kind="user"/>`;
  }

  const textParts: string[] = [];
  const toolResultParts: string[] = [];
  for (const block of content) {
    if (isTextBlock(block)) {
      if (typeof block.text === "string") textParts.push(shrinkText(block.text, ix, ctx));
    } else if (isToolResultBlock(block)) {
      toolResultParts.push(renderToolResultBlock(block, ix, ctx));
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

function renderToolResultBlock(block: ToolResultBlock, ix: number, ctx: TurnContext): string {
  const use = ctx.toolUseById.get(block.tool_use_id);
  const name = use?.name ?? "unknown";
  const summary = condenseToolUse(name, use?.input ?? {}, block);
  ctx.stats.stubbedToolResultCount += 1;
  const rawLen = Buffer.byteLength(toolResultText(block), "utf8");
  const savings = Math.max(0, rawLen - Buffer.byteLength(summary, "utf8"));
  ctx.stats.bytesSaved += savings;
  const errAttr = block.is_error ? ' is_error="true"' : "";
  return `<tool_result name="${escapeXmlAttr(name)}"${errAttr}>${escapeXmlText(summary)}</tool_result>`;
}

function shrinkText(text: string, ix: number, ctx: TurnContext): string {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= ctx.maxFieldBytes) return escapeXmlText(text);

  ctx.stats.truncatedInputFieldCount += 1;
  const preview = ctx.previewChars > 0 ? text.slice(0, ctx.previewChars) : "";
  const marker = `[COMPACTION STUB — ${bytes} bytes removed. Retrieve via: ${ctx.ambixCmd} ${ctx.origSessionId} ${ix}]`;
  const body = preview
    ? `<truncated>\n${escapeXmlText(preview)}…\n</truncated>\n${escapeXmlText(marker)}`
    : escapeXmlText(marker);
  ctx.stats.bytesSaved += Math.max(0, bytes - Buffer.byteLength(body, "utf8"));
  return body;
}

// Minimal XML escape — the turn content is embedded inside a broader XML
// envelope, so reserved chars must be escaped. We're deliberately permissive
// (don't escape quotes in body text) to keep the output readable.
//
// XML 1.0 forbids most ASCII control bytes in text content (only \t, \n, \r
// are legal below U+0020). Tool output sometimes contains control bytes
// (ANSI sequences in streamed Bash output, NULs in binary-adjacent stdout);
// strip them so the outer `<turns>` block stays parseable by anything that
// actually parses it. Losing these chars is safe — they're not meaningful
// in a text summary.
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional strip of XML-illegal control chars
const XML_ILLEGAL_CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

function stripIllegalControl(s: string): string {
  return s.replace(XML_ILLEGAL_CONTROL_RE, "");
}

function escapeXmlText(s: string): string {
  return stripIllegalControl(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escapeXmlAttr(s: string): string {
  return stripIllegalControl(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

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
    "Do NOT infer or guess what a condensed turn contained — the prose is a summary, not the real payload. Run the embedded command when you need the actual content.",
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
 * so structural and bundled modes draw the boundary at the same place —
 * subtle divergences here would surface as surprising --full-recent behavior.
 */
function computePreservedFirstIx(entries: ReadonlyArray<LogEntry>, fullRecent: number): number {
  if (fullRecent <= 0 || entries.length === 0) return entries.length;
  const indexed = entries.map((entry, ix) => ({ entry, ix }));
  const rounds = groupIntoRounds(indexed);
  if (rounds.length === 0) return entries.length;
  const pickIdx = Math.max(0, rounds.length - fullRecent);
  return rounds[pickIdx].userIx;
}
