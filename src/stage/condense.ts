// src/stage/condense.ts
import type {
  LogEntry,
  AssistantEntry,
  UserEntry,
} from "parse-claude-logs";
import {
  isAssistantEntry,
  isUserEntry,
  isSystemEntry,
  isSummaryEntry,
  isAttachmentEntry,
} from "parse-claude-logs";
import type { CondensedEntry } from "../types.js";

/** Options controlling condensation. */
export interface CondenseOptions {
  /** Inline content larger than this (in bytes of JSON) becomes a stub. */
  maxInlineBytes: number;
}

/**
 * Convert a `LogEntry[]` from parse-claude-logs into the condensed
 * `CondensedEntry[]` format alembic ships to the distiller agent.
 *
 * This is the basic version: assigns ix, builds parent_ix from uuid
 * linkage, copies content through unchanged. Truncation logic is
 * added in a follow-up task.
 */
export function condenseEntries(
  entries: ReadonlyArray<LogEntry>,
  _opts: CondenseOptions
): CondensedEntry[] {
  const uuidToIx = new Map<string, number>();
  const out: CondensedEntry[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const uuid = (entry as { uuid?: string }).uuid ?? "";
    if (uuid) uuidToIx.set(uuid, i);
  }

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const uuid = (entry as { uuid?: string }).uuid ?? "";
    const parentUuid = (entry as { parentUuid?: string | null }).parentUuid ?? null;
    const ts = (entry as { timestamp?: string }).timestamp ?? null;

    const condensed: CondensedEntry = {
      ix: i,
      ref: uuid ? `uuid:${uuid}` : `ix:${i}`,
      parent_ix: parentUuid ? uuidToIx.get(parentUuid) ?? null : null,
      role: roleOf(entry),
      type: entry.type,
      ts,
      content: extractContent(entry),
    };

    if (isAssistantEntry(entry)) {
      condensed.tokens = extractTokens(entry);
      if (entry.message.model === "<synthetic>") {
        condensed.synthetic = true;
      }
    }

    out.push(condensed);
  }

  return out;
}

function roleOf(entry: LogEntry): CondensedEntry["role"] {
  if (isUserEntry(entry)) return "user";
  if (isAssistantEntry(entry)) return "assistant";
  if (isSystemEntry(entry)) return "system";
  if (isSummaryEntry(entry)) return "summary";
  if (isAttachmentEntry(entry)) return "attachment";
  return "other";
}

function extractContent(entry: LogEntry): unknown {
  if (isUserEntry(entry)) {
    const e = entry as UserEntry;
    return e.message.content;
  }
  if (isAssistantEntry(entry)) {
    const e = entry as AssistantEntry;
    return e.message.content;
  }
  if (isSystemEntry(entry)) {
    return entry.content ?? null;
  }
  if (isSummaryEntry(entry)) {
    return entry.summary;
  }
  if (isAttachmentEntry(entry)) {
    return entry.attachment;
  }
  return null;
}

function extractTokens(entry: AssistantEntry): CondensedEntry["tokens"] {
  const u = entry.message.usage;
  const tokens: NonNullable<CondensedEntry["tokens"]> = {
    in: u.input_tokens,
    out: u.output_tokens,
  };
  if (u.cache_read_input_tokens !== undefined) {
    tokens.cache_read = u.cache_read_input_tokens;
  }
  if (u.cache_creation_input_tokens !== undefined) {
    tokens.cache_write = u.cache_creation_input_tokens;
  }
  return tokens;
}
