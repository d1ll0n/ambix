// src/compact/rounds.ts
//
// Round-level analysis for `alembic compact`:
//
//   • extractUserText   — returns the text of a *human* user message
//                         (rejects tool_result-wrapper user entries)
//   • isWrapperOnly     — filters out rounds whose sole content is
//                         harness wrappers (<local-command-caveat>,
//                         /clear, system-reminder, etc.)
//   • groupIntoRounds   — split the deduped entry stream into rounds
//   • iterRoundStream   — walk one round's assistant content in order,
//                         yielding text blocks and tool_use one-liners
//                         with their source entry's ix

import type { AssistantEntry, LogEntry, ToolResultBlock } from "parse-claude-logs";
import {
  isAssistantEntry,
  isTextBlock,
  isToolResultBlock,
  isToolUseBlock,
  isUserEntry,
} from "parse-claude-logs";
import { condenseToolUse } from "./condensers.js";

/** Indexed log entry — `ix` is its position in the deduped entry list. */
export interface IndexedEntry {
  entry: LogEntry;
  ix: number;
}

/** One round: everything between two consecutive human user messages. */
export interface Round {
  /** ix of the user message that opens this round. */
  userIx: number;
  /** The text the human typed in this round's opening user message. */
  userText: string;
  /** All entries in this round, starting with the user message. */
  entries: IndexedEntry[];
}

/** Emitted by `iterRoundStream`. */
export interface StreamItem {
  kind: "text" | "tool";
  payload: string;
  ix: number;
}

/**
 * Return the human text of a user message. Returns `null` when the
 * user entry is a tool_result wrapper (not a real human turn) or has
 * no renderable text.
 */
export function extractUserText(entry: LogEntry): string | null {
  if (!isUserEntry(entry)) return null;
  const content = entry.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const blk of content) {
      if (blk && typeof blk === "object") {
        const rec = blk as { type?: string; text?: unknown };
        if (rec.type === "tool_result") return null;
        if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  return null;
}

// Matches harness-wrapper tags that sometimes comprise an entire user
// message (so the round is noise, not a real prompt).
const WRAPPER_TAG_RE =
  /<(local-command-caveat|command-name|command-message|command-args|command-stdout|system-reminder|local-command-stdout)>[\s\S]*?<\/\1>/gi;

/**
 * True if `text` is entirely harness wrappers (local-command-caveat,
 * command-name, system-reminder, ...) with no actual human content.
 */
export function isWrapperOnly(text: string): boolean {
  const stripped = text
    .replace(WRAPPER_TAG_RE, "")
    .replace(/<\/?[a-zA-Z-]+>/g, "")
    .trim();
  return stripped.length === 0;
}

/**
 * Split the deduped entry stream into rounds. A round starts at each
 * human user message and contains every subsequent entry up to (but
 * not including) the next human user message.
 *
 * Preamble entries that occur before the first human message are
 * dropped, matching the Python prototype's behavior.
 */
export function groupIntoRounds(indexed: IndexedEntry[]): Round[] {
  const rounds: Round[] = [];
  let current: Round | null = null;
  for (const ie of indexed) {
    const userText = extractUserText(ie.entry);
    if (userText !== null) {
      if (current) rounds.push(current);
      current = { userIx: ie.ix, userText, entries: [ie] };
    } else if (current) {
      current.entries.push(ie);
    }
  }
  if (current) rounds.push(current);
  return rounds;
}

/**
 * Walk every assistant entry in this round's stream and yield its
 * text blocks and tool_use blocks in source order. Tool_result blocks
 * live on user entries and are looked up by id from `resultsById`.
 */
export function* iterRoundStream(
  round: Round,
  resultsById: Map<string, ToolResultBlock>
): Generator<StreamItem> {
  // Skip the opening user message; it's the prompt, not part of the stream.
  for (let i = 1; i < round.entries.length; i++) {
    const { entry, ix } = round.entries[i];
    if (!isAssistantEntry(entry)) continue;
    const content = (entry as AssistantEntry).message.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (isTextBlock(blk)) {
        const text = (blk.text ?? "").trim();
        if (text) yield { kind: "text", payload: text, ix };
      } else if (isToolUseBlock(blk)) {
        const result = resultsById.get(blk.id) ?? null;
        yield {
          kind: "tool",
          payload: condenseToolUse(blk.name, blk.input, result),
          ix,
        };
      }
      // thinking / image / other blocks: skip (no compact signal)
    }
  }
}

/**
 * Scan every entry in the deduped stream for tool_result blocks and
 * return a `tool_use_id → tool_result` lookup. Built once per session
 * so each round can correlate tool_uses with their results cheaply.
 */
export function buildToolResultIndex(indexed: IndexedEntry[]): Map<string, ToolResultBlock> {
  const out = new Map<string, ToolResultBlock>();
  for (const { entry } of indexed) {
    if (!isUserEntry(entry)) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const blk of content) {
      if (isToolResultBlock(blk)) {
        out.set(blk.tool_use_id, blk);
      }
    }
  }
  return out;
}

/** First non-null `gitBranch` seen on any entry in the round. */
export function roundBranch(round: Round): string | null {
  for (const { entry } of round.entries) {
    const b = (entry as { gitBranch?: unknown }).gitBranch;
    if (typeof b === "string" && b) return b;
  }
  return null;
}
