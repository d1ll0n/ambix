// src/compact-session/emit.ts
import { randomUUID } from "node:crypto";
import type { LogEntry, ToolResultBlock } from "parse-cc";
import {
  isAssistantEntry,
  isFileHistorySnapshotEntry,
  isToolResultBlock,
  isToolUseBlock,
  isUserEntry,
} from "parse-cc";
import { groupIntoRounds } from "../brief/rounds.js";
import { buildStub, measureToolResultBytes } from "./stub.js";
import { buildSummaryEntry } from "./summary.js";
import { truncateOversizedStrings } from "./truncate.js";
import type { CompactSessionStats } from "./types.js";

/** Default UTF-8 byte threshold for single-string-field truncation in condensed entries. */
export const DEFAULT_MAX_FIELD_BYTES = 500;
/** Default number of chars retained as a preview in front of the truncation marker. */
export const DEFAULT_PREVIEW_CHARS = 100;

export interface EmitOptions {
  /** Source session's deduped entry stream. */
  sourceEntries: ReadonlyArray<LogEntry>;
  /** UUID assigned to the new compacted session. */
  newSessionId: string;
  /** UUID of the source session — cited in stubs. */
  origSessionId: string;
  /** N rounds to preserve verbatim at the tail. */
  fullRecent: number;
  /** Metadata copied onto the divider. */
  cwd: string;
  gitBranch: string;
  version: string;
  /** Override summary uuid / promptId / timestamp (for deterministic tests). */
  summaryUuid?: string;
  summaryPromptId?: string;
  summaryTimestamp?: string;
  /** Override every per-entry uuid (for deterministic tests). Default: randomUUID. */
  uuidFn?: () => string;
  /** Stub command prefix override. Default `"ambix query"`. */
  ambixCmd?: string;
  /** UTF-8 byte threshold for single-field truncation. Default {@link DEFAULT_MAX_FIELD_BYTES}. */
  maxFieldBytes?: number;
  /** Preview chars kept in front of the truncation marker. Default {@link DEFAULT_PREVIEW_CHARS}. */
  previewChars?: number;
}

export interface EmitResult {
  entries: ReadonlyArray<Record<string, unknown>>;
  stats: CompactSessionStats;
}

/**
 * Walk a source session's entries and emit the compacted sequence:
 *   [condensed entries with stubbed tool_result bodies]
 *   [isCompactSummary divider]
 *   [preserved-verbatim entries]
 *
 * parentUuid chain is rebuilt so the emitted file is a self-contained
 * linear conversation. sessionId on every emitted entry is the new UUID.
 */
export function emit(opts: EmitOptions): EmitResult {
  const uuidFn = opts.uuidFn ?? randomUUID;
  const entries = opts.sourceEntries;

  // Where does the preserved (verbatim) section begin? Last N rounds, taking
  // the `userIx` of the first preserved round as the split point.
  const indexed = entries.map((entry, ix) => ({ entry, ix }));
  const rounds = groupIntoRounds(indexed);
  const preservedRounds = opts.fullRecent > 0 ? rounds.slice(-opts.fullRecent) : [];
  const preservedFirstIx = preservedRounds.length > 0 ? preservedRounds[0].userIx : entries.length;

  // Index tool_use_id → { name, input, sourceIx } for stub construction.
  const toolUseMap = new Map<string, { name: string; input: unknown; ix: number }>();
  for (let ix = 0; ix < entries.length; ix++) {
    const e = entries[ix];
    if (!isAssistantEntry(e)) continue;
    for (const blk of e.message.content) {
      if (isToolUseBlock(blk)) {
        toolUseMap.set(blk.id, { name: blk.name, input: blk.input, ix });
      }
    }
  }

  const stats: CompactSessionStats = {
    sourceEntryCount: entries.length,
    condensedEntryCount: 0,
    preservedEntryCount: 0,
    droppedEntryCount: 0,
    stubbedToolResultCount: 0,
    truncatedInputFieldCount: 0,
    bytesSaved: 0,
  };

  const emitted: Record<string, unknown>[] = [];
  let prevUuid: string | null = null;
  let dividerInserted = false;

  const insertDivider = (
    condensedLastIx: number,
    preservedFirstIxArg: number,
    lastSourceIx: number
  ) => {
    const divider = buildSummaryEntry({
      origSessionId: opts.origSessionId,
      newSessionId: opts.newSessionId,
      parentUuid: prevUuid,
      cwd: opts.cwd,
      gitBranch: opts.gitBranch,
      version: opts.version,
      condensedLastIx,
      preservedFirstIx: preservedFirstIxArg,
      lastSourceIx,
      fullRecent: opts.fullRecent,
      uuid: opts.summaryUuid,
      promptId: opts.summaryPromptId,
      now: opts.summaryTimestamp,
    });
    emitted.push(divider);
    prevUuid = divider.uuid as string;
    dividerInserted = true;
  };

  for (let ix = 0; ix < entries.length; ix++) {
    // Insert divider at the split point (between last condensed and first preserved)
    if (ix === preservedFirstIx && !dividerInserted) {
      insertDivider(ix - 1, preservedFirstIx, entries.length - 1);
    }

    const inPreserved = ix >= preservedFirstIx;
    const source = entries[ix];

    // Drop file-history-snapshot entries in the condensed section. They carry
    // CC's per-file backup metadata (trackedFileBackups maps) that CC never
    // feeds to the model on resume — pure bookkeeping, often 8+ KB each and
    // ~100s per session. The preserved section keeps them verbatim so CC's
    // own file-history tooling stays intact for the recent window.
    if (!inPreserved && isFileHistorySnapshotEntry(source)) {
      const dropped = Buffer.byteLength(JSON.stringify(source), "utf8");
      stats.droppedEntryCount += 1;
      stats.bytesSaved += dropped;
      continue;
    }

    const newUuid = uuidFn();
    const { entry: newEntry, hasUuid } = rewriteEntry({
      source,
      sourceIx: ix,
      newUuid,
      newSessionId: opts.newSessionId,
      parentUuid: prevUuid,
      condense: !inPreserved,
      origSessionId: opts.origSessionId,
      toolUseMap,
      ambixCmd: opts.ambixCmd,
      maxFieldBytes: opts.maxFieldBytes,
      previewChars: opts.previewChars,
      stats,
      uuidFn,
    });
    emitted.push(newEntry);
    // Only conversational entries (those with a source uuid) participate in the
    // parentUuid chain. Structural entries pass through out-of-band, so the
    // next conversational entry still parents off the previous conversational one.
    if (hasUuid) prevUuid = newUuid;

    if (inPreserved) stats.preservedEntryCount++;
    else stats.condensedEntryCount++;
  }

  // If `--full-recent N` >= round count, everything is condensed (preservedFirstIx
  // is past the end) — append the divider at the end so the agent still has the
  // explanatory preamble. condensedLastIx = last source ix, preservedFirstIx
  // past-the-end marks empty preserved.
  if (!dividerInserted) {
    insertDivider(entries.length - 1, entries.length, entries.length - 1);
  }

  return { entries: emitted, stats };
}

interface RewriteOpts {
  source: LogEntry;
  /** Source ix of this entry — embedded in stubs so `ambix query <id> <ix>` resolves to this tool_result, not its paired tool_use. */
  sourceIx: number;
  newUuid: string;
  newSessionId: string;
  parentUuid: string | null;
  /** When true, user tool_result blocks have their `content` swapped for a stub. */
  condense: boolean;
  origSessionId: string;
  toolUseMap: Map<string, { name: string; input: unknown; ix: number }>;
  ambixCmd?: string;
  maxFieldBytes?: number;
  previewChars?: number;
  stats: CompactSessionStats;
  uuidFn: () => string;
}

function rewriteEntry(opts: RewriteOpts): { entry: Record<string, unknown>; hasUuid: boolean } {
  // Clone to avoid mutating the source entry (parse-cc returns shared objects).
  const cloned = JSON.parse(JSON.stringify(opts.source)) as Record<string, unknown>;

  // Only rewrite fields that exist on the source. Adding `uuid`/`parentUuid`
  // to entries that didn't have them (permission-mode, file-history-snapshot,
  // queue-operation, last-prompt, …) injects those structural records into
  // CC's conversation chain — CC then walks past them and fails to collect
  // the real user/assistant turns. Structural entries must stay out-of-band.
  const hasUuid = "uuid" in cloned;
  if (hasUuid) cloned.uuid = opts.newUuid;
  if ("parentUuid" in cloned) cloned.parentUuid = opts.parentUuid;
  if ("sessionId" in cloned) cloned.sessionId = opts.newSessionId;

  // Regenerate cross-entry identifiers that CC treats as globally-scoped
  // routing keys (fork/branch tracking, request dedup). Leaving source-session
  // values in place makes CC associate the compacted entries back to the source
  // session and skip them when building the resume context. Fresh IDs detach
  // the compacted session cleanly.
  regenerateRoutingIds(cloned, opts.uuidFn);

  if (opts.condense) {
    condenseEntry(
      cloned,
      opts.source,
      opts.sourceIx,
      opts.origSessionId,
      opts.toolUseMap,
      opts.ambixCmd,
      opts.maxFieldBytes,
      opts.previewChars,
      opts.stats
    );
  }

  return { entry: cloned, hasUuid };
}

function regenerateRoutingIds(cloned: Record<string, unknown>, uuidFn: () => string): void {
  // promptId — present on user/assistant entries; plain UUID in CC.
  if (typeof cloned.promptId === "string") cloned.promptId = uuidFn();

  // requestId — assistant-only, Anthropic API request identifier.
  if (typeof cloned.requestId === "string") {
    cloned.requestId = `req_${uuidFn().replaceAll("-", "").slice(0, 22)}`;
  }

  // message.id — assistant-only, Anthropic API message identifier.
  const msg = cloned.message;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (typeof m.id === "string") {
      m.id = `msg_${uuidFn().replaceAll("-", "").slice(0, 22)}`;
    }
  }
}

/**
 * Condense a single entry in the condensed section:
 *   - User entries: tool_result content gets a nice per-tool condenser summary;
 *     plain user-text `message.content` strings pass through intact.
 *   - Assistant entries: tool_use.input fields get swept (Edit old/new_string,
 *     Write content, MCP payloads); text blocks' `text` field is preserved.
 *   - Every entry type: sweep everything OUTSIDE `message.content`
 *     (toolUseResult sidecars on Edit tool_results, attachment.stdout on
 *     SessionStart hooks, etc.). This is the safety net for unknown shapes.
 *
 * Conversational text (human utterances + assistant explanations) is always
 * preserved — the compacted session's point is to keep the transcript
 * readable while deleting bulk tool byproducts.
 */
function condenseEntry(
  cloned: Record<string, unknown>,
  source: LogEntry,
  sourceIx: number,
  origSessionId: string,
  toolUseMap: Map<string, { name: string; input: unknown; ix: number }>,
  ambixCmd: string | undefined,
  maxFieldBytes: number | undefined,
  previewChars: number | undefined,
  stats: CompactSessionStats
): void {
  const cmd = ambixCmd ?? "ambix query";
  const threshold = maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
  const preview = previewChars ?? DEFAULT_PREVIEW_CHARS;
  const marker = `[COMPACTION STUB — field truncated. Retrieve full entry via: ${cmd} ${origSessionId} ${sourceIx}]`;
  const sweepOpts = { maxFieldBytes: threshold, marker, previewChars: preview };

  // 1. Tool_result stubbing (user entries) — preserves tool_use→tool_result
  //    pairing with a descriptive one-liner rather than a generic marker.
  if (isUserEntry(source)) {
    stubToolResultsInUserEntry(cloned, sourceIx, origSessionId, toolUseMap, ambixCmd, stats);
  }

  // 2. Walk message.content type-aware:
  //    - tool_use blocks: truncate input fields
  //    - text blocks: preserve (conversational content)
  //    - tool_result blocks: skip (handled by step 1)
  //    - document / image / anything else: sweep (catches base64 blobs,
  //      large attachment payloads that aren't the agent's words)
  const msg = cloned.message;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    const content = m.content;
    if (Array.isArray(content)) {
      for (const blk of content) {
        if (!blk || typeof blk !== "object") continue;
        const b = blk as Record<string, unknown>;
        const subStats = { truncatedFieldCount: 0, bytesSaved: 0 };
        if (b.type === "tool_use" && b.input !== undefined && b.input !== null) {
          b.input = truncateOversizedStrings(b.input, sweepOpts, subStats);
        } else if (b.type === "text" || b.type === "tool_result") {
          // preserve text (conversational); tool_result already stubbed
        } else {
          // document / image / other non-text block type — sweep all string
          // fields. Base64 payloads land in `source.data` for document/image
          // blocks and the sweep collapses them.
          for (const [k, v] of Object.entries(b)) {
            if (k === "type") continue;
            b[k] = truncateOversizedStrings(v, sweepOpts, subStats);
          }
        }
        stats.truncatedInputFieldCount += subStats.truncatedFieldCount;
        stats.bytesSaved += subStats.bytesSaved;
      }
    }
    // When `content` is a string (plain user text), pass through.
  }

  // 3. For fields outside `message`: sweep most of them, but replace
  //    `toolUseResult` entirely — it's CC's UI-only sidecar that duplicates
  //    data we've already summarized in the stubbed tool_result block.
  //    Its nested structures rarely trigger per-field truncation (each
  //    leaf is under the threshold) yet aggregate to 10-20KB per Edit.
  for (const [k, v] of Object.entries(cloned)) {
    if (k === "message") continue;
    if (k === "toolUseResult" && v !== null && v !== undefined) {
      const originalBytes = Buffer.byteLength(JSON.stringify(v), "utf8");
      if (originalBytes > threshold) {
        cloned[k] = marker;
        stats.truncatedInputFieldCount += 1;
        stats.bytesSaved += Math.max(0, originalBytes - Buffer.byteLength(marker, "utf8"));
      }
      continue;
    }
    const subStats = { truncatedFieldCount: 0, bytesSaved: 0 };
    cloned[k] = truncateOversizedStrings(v, sweepOpts, subStats);
    stats.truncatedInputFieldCount += subStats.truncatedFieldCount;
    stats.bytesSaved += subStats.bytesSaved;
  }
}

function stubToolResultsInUserEntry(
  cloned: Record<string, unknown>,
  sourceIx: number,
  origSessionId: string,
  toolUseMap: Map<string, { name: string; input: unknown; ix: number }>,
  ambixCmd: string | undefined,
  stats: CompactSessionStats
): void {
  const msg = cloned.message as { content: unknown };
  const content = msg.content;
  if (!Array.isArray(content)) return;
  for (let i = 0; i < content.length; i++) {
    const blk = content[i] as Record<string, unknown>;
    if (!isToolResultBlock(blk as unknown as ToolResultBlock)) continue;
    const resultBlk = blk as unknown as ToolResultBlock;
    const toolInfo = toolUseMap.get(resultBlk.tool_use_id);
    const originalBytes = measureToolResultBytes(resultBlk);
    // Use the tool_result entry's own ix (this entry), NOT the paired tool_use's,
    // so `ambix query <session> <ix>` returns the original tool_result body
    // rather than the tool_use call (which is already visible in the compacted file).
    const stub = buildStub({
      origSessionId,
      ix: sourceIx,
      toolName: toolInfo?.name ?? "unknown",
      toolInput: toolInfo?.input ?? {},
      originalResult: resultBlk,
      ambixCmd,
    });
    blk.content = stub;
    stats.stubbedToolResultCount++;
    stats.bytesSaved += Math.max(0, originalBytes - Buffer.byteLength(stub, "utf8"));
  }
}
