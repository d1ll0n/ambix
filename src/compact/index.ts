// src/compact/index.ts
//
// Top-level entry point for the `alembic compact` subcommand. Produces
// a chronological, per-round summary of a Claude Code session with
// condensed tool_use lines and rehydration indices — intended as a
// context-recovery artifact that a new agent session can load in place
// of Claude Code's built-in /compact output.

import type { LogEntry, Session, ToolResultBlock } from "parse-claude-logs";
import { isAssistantEntry, isTextBlock, isToolUseBlock } from "parse-claude-logs";
import { estTokens } from "./condensers.js";
import {
  buildToolResultIndex,
  groupIntoRounds,
  isWrapperOnly,
  type IndexedEntry,
  type Round,
} from "./rounds.js";
import { renderCompact, type CompactFormat } from "./render.js";

export interface CompactOptions {
  /** Output format. Default `"xml"`. */
  format?: CompactFormat;
}

export interface CompactStats {
  /** Number of rounds rendered (wrapper-only rounds excluded). */
  rounds: number;
  /** Number of rounds before wrapper filtering. */
  rawRounds: number;
  /** Total tool_use blocks across all rendered rounds. */
  toolUses: number;
  /** Rough char/4 estimate of total assistant text across the session. */
  assistantTextTokens: number;
  /** Number of entries in the deduped stream (session.messages() length). */
  entryCount: number;
}

export interface CompactResult {
  content: string;
  stats: CompactStats;
}

/** Produce a compact render for a single Claude Code session. */
export async function compactSession(
  session: Session,
  opts: CompactOptions = {}
): Promise<CompactResult> {
  const entries = await session.messages();
  const indexed: IndexedEntry[] = entries.map((entry, ix) => ({ entry, ix }));
  const allRounds = groupIntoRounds(indexed);
  const rounds = allRounds.filter((r) => !isWrapperOnly(r.userText));
  const resultsById = buildToolResultIndex(indexed);
  const stats = computeStats(entries, rounds, allRounds.length);

  const format = opts.format ?? "xml";
  const content = renderCompact(format, rounds, resultsById, {
    source: session.path,
    totalRounds: stats.rounds,
    assistantTextTokens: stats.assistantTextTokens,
    toolUseCount: stats.toolUses,
  });

  return { content, stats };
}

function computeStats(
  entries: LogEntry[],
  rounds: Round[],
  rawRounds: number
): CompactStats {
  let toolUses = 0;
  let assistantTextTokens = 0;
  for (const entry of entries) {
    if (!isAssistantEntry(entry)) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (isToolUseBlock(blk)) {
        toolUses += 1;
      } else if (isTextBlock(blk) && typeof blk.text === "string") {
        assistantTextTokens += estTokens(blk.text);
      }
    }
  }
  return {
    rounds: rounds.length,
    rawRounds,
    toolUses,
    assistantTextTokens,
    entryCount: entries.length,
  };
}

export type { CompactFormat };
export { type Round };
// Keep a handle exported so a consumer can reuse a cached tool_result index
// across multiple renders if they ever need to (e.g. rendering both XML and
// markdown from one session instance).
export { buildToolResultIndex } from "./rounds.js";
