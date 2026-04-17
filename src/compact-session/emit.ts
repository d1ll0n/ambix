// src/compact-session/emit.ts
import { randomUUID } from "node:crypto";
import type { LogEntry, ToolResultBlock } from "parse-cc";
import { isAssistantEntry, isToolResultBlock, isToolUseBlock, isUserEntry } from "parse-cc";
import { groupIntoRounds } from "../brief/rounds.js";
import { buildStub, measureToolResultBytes } from "./stub.js";
import { buildSummaryEntry } from "./summary.js";
import type { CompactSessionStats } from "./types.js";

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
    stubbedToolResultCount: 0,
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

  if (opts.condense && isUserEntry(opts.source)) {
    stubToolResultsInUserEntry(
      cloned,
      opts.sourceIx,
      opts.origSessionId,
      opts.toolUseMap,
      opts.ambixCmd,
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
