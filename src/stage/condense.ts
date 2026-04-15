// src/stage/condense.ts
import type { AssistantEntry, ContentBlock, LogEntry, UserEntry } from "parse-claude-logs";
import {
  isAssistantEntry,
  isAttachmentEntry,
  isFileHistorySnapshotEntry,
  isImageBlock,
  isLastPromptEntry,
  isPermissionModeEntry,
  isProgressEntry,
  isQueueOperationEntry,
  isSummaryEntry,
  isSystemEntry,
  isTextBlock,
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
  isUserEntry,
  parsePersistedOutput,
} from "parse-claude-logs";
import type { CondensedEntry, RehydrationStub } from "../types.js";

/** Options controlling condensation. */
export interface CondenseOptions {
  /** Inline content larger than this (in bytes of JSON) becomes a stub. */
  maxInlineBytes: number;
  /** Preview length for truncated content. */
  previewChars?: number;
}

// Metadata fields to strip from non-message entry payloads.
const METADATA_KEYS = new Set([
  "uuid",
  "parentUuid",
  "timestamp",
  "sessionId",
  "type",
  "cwd",
  "gitBranch",
  "version",
  "isSidechain",
  "userType",
  "agentId",
]);

/** Convert LogEntry[] into the condensed format with truncation stubs. */
export function condenseEntries(
  entries: ReadonlyArray<LogEntry>,
  opts: CondenseOptions
): CondensedEntry[] {
  const uuidToIx = new Map<string, number>();
  for (let i = 0; i < entries.length; i++) {
    const u = (entries[i] as { uuid?: string }).uuid;
    if (u) uuidToIx.set(u, i);
  }

  const out: CondensedEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    out.push(condenseOne(entries[i], i, uuidToIx, opts));
  }
  return out;
}

function condenseOne(
  entry: LogEntry,
  ix: number,
  uuidToIx: Map<string, number>,
  opts: CondenseOptions
): CondensedEntry {
  const uuid = (entry as { uuid?: string }).uuid ?? "";
  const parentUuid = (entry as { parentUuid?: string | null }).parentUuid ?? null;
  const ts = (entry as { timestamp?: string }).timestamp ?? null;

  const condensed: CondensedEntry = {
    ix,
    ref: uuid ? `uuid:${uuid}` : `ix:${ix}`,
    parent_ix: parentUuid ? (uuidToIx.get(parentUuid) ?? null) : null,
    role: roleOf(entry),
    type: entry.type,
    ts,
    content: extractContent(entry, ix, opts),
  };

  if (isAssistantEntry(entry)) {
    condensed.tokens = extractTokens(entry);
    if (entry.message.model === "<synthetic>") {
      condensed.synthetic = true;
    }
  }

  return condensed;
}

function roleOf(entry: LogEntry): CondensedEntry["role"] {
  if (isUserEntry(entry)) return "user";
  if (isAssistantEntry(entry)) return "assistant";
  if (isSystemEntry(entry)) return "system";
  if (isSummaryEntry(entry)) return "summary";
  if (isAttachmentEntry(entry)) return "attachment";
  return "other";
}

/** Content extraction — dispatches by entry type. */
function extractContent(entry: LogEntry, ix: number, opts: CondenseOptions): unknown {
  if (isUserEntry(entry)) {
    const e = entry as UserEntry;
    if (typeof e.message.content === "string") {
      return maybeStub(e.message.content, ix, opts);
    }
    return e.message.content.map((b) => condenseBlock(b, ix, opts));
  }

  if (isAssistantEntry(entry)) {
    const e = entry as AssistantEntry;
    return e.message.content.map((b) => condenseBlock(b, ix, opts));
  }

  // All other known and unknown entry types: preserve payload minus metadata fields.
  return preservedEntryPayload(entry);
}

/**
 * Shallow copy of the source entry with common metadata fields stripped.
 * Used for system, summary, attachment, file-history-snapshot, queue-operation,
 * permission-mode, progress, last-prompt, and unknown entries.
 */
function preservedEntryPayload(entry: LogEntry): Record<string, unknown> {
  const raw = entry as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!METADATA_KEYS.has(k)) {
      out[k] = v;
    }
  }
  return out;
}

/** Block-level condensation for user/assistant content arrays. */
function condenseBlock(block: ContentBlock, ix: number, opts: CondenseOptions): unknown {
  if (isToolUseBlock(block)) {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: condenseToolInput(block.input, ix, opts),
    };
  }

  if (isToolResultBlock(block)) {
    const result: Record<string, unknown> = {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      result: condenseToolResultContent(block.content, ix, opts),
    };
    if (block.is_error) {
      result.is_error = true;
    }
    return result;
  }

  if (isTextBlock(block)) {
    return { type: "text", text: maybeStub(block.text, ix, opts) };
  }

  if (isThinkingBlock(block)) {
    const out: Record<string, unknown> = {
      type: "thinking",
      thinking: maybeStub(block.thinking, ix, opts),
    };
    if ((block as { signature?: string }).signature !== undefined) {
      out.signature = (block as { signature?: string }).signature;
    }
    return out;
  }

  // image blocks and unknown blocks pass through unchanged
  return block;
}

/**
 * Per-field truncation for tool_use inputs.
 * Small fields stay inline; large string fields become stubs.
 */
function condenseToolInput(input: unknown, ix: number, opts: CondenseOptions): unknown {
  if (input === null || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string" && byteLength(v) > opts.maxInlineBytes) {
      out[k] = makeStub(
        `turns/${String(ix).padStart(5, "0")}.json`,
        v,
        v.slice(0, opts.previewChars ?? 500),
        opts
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Tool_result content condensation.
 * Handles string (with persisted-output detection), arrays, and other values.
 */
function condenseToolResultContent(content: unknown, ix: number, opts: CondenseOptions): unknown {
  if (typeof content === "string") {
    const persisted = parsePersistedOutput(content);
    if (persisted) {
      const fileName = persisted.filePath.split("/").pop() ?? "spill.txt";
      const bytes = byteLength(content);
      return {
        truncated: true,
        ref: `spill/${fileName}`,
        bytes,
        tokens_est: estTokens(bytes),
        preview: persisted.preview,
      } satisfies RehydrationStub;
    }
    if (byteLength(content) > opts.maxInlineBytes) {
      return makeStub(
        `turns/${String(ix).padStart(5, "0")}.json`,
        content,
        content.slice(0, opts.previewChars ?? 500),
        opts
      );
    }
    return content;
  }

  if (Array.isArray(content)) {
    return (content as ContentBlock[]).map((b) => condenseBlock(b, ix, opts));
  }

  return content;
}

/** String → string or stub. Used for text blocks, thinking blocks, user string content. */
function maybeStub(value: unknown, ix: number, opts: CondenseOptions): unknown {
  if (typeof value !== "string") return value;
  if (byteLength(value) <= opts.maxInlineBytes) return value;
  return makeStub(
    `turns/${String(ix).padStart(5, "0")}.json`,
    value,
    value.slice(0, opts.previewChars ?? 500),
    opts
  );
}

/** Build a uniform RehydrationStub. */
function makeStub(
  ref: string,
  full: string,
  preview: string,
  _opts: CondenseOptions
): RehydrationStub {
  const bytes = byteLength(full);
  return {
    truncated: true,
    ref,
    bytes,
    tokens_est: estTokens(bytes),
    preview,
  };
}

function extractTokens(entry: AssistantEntry): CondensedEntry["tokens"] {
  const u = entry.message.usage;
  const tokens: NonNullable<CondensedEntry["tokens"]> = {
    in: u.input_tokens,
    out: u.output_tokens,
  };
  if (u.cache_read_input_tokens !== undefined) tokens.cache_read = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens !== undefined)
    tokens.cache_write = u.cache_creation_input_tokens;
  return tokens;
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function estTokens(bytes: number): number {
  return Math.round(bytes / 4);
}
