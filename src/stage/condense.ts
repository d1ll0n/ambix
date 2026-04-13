// src/stage/condense.ts
import type {
  LogEntry,
  AssistantEntry,
  UserEntry,
  ContentBlock,
} from "parse-claude-logs";
import {
  isAssistantEntry,
  isUserEntry,
  isSystemEntry,
  isSummaryEntry,
  isAttachmentEntry,
  isToolUseBlock,
  isToolResultBlock,
  parsePersistedOutput,
} from "parse-claude-logs";
import type { CondensedEntry, RehydrationStub } from "../types.js";
import { makePreview } from "./preview.js";

/** Options controlling condensation. */
export interface CondenseOptions {
  /** Inline content larger than this (in bytes of JSON) becomes a stub. */
  maxInlineBytes: number;
  /** Preview length for truncated content. */
  previewChars?: number;
}

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
    parent_ix: parentUuid ? uuidToIx.get(parentUuid) ?? null : null,
    role: roleOf(entry),
    type: entry.type,
    ts,
    content: condenseContent(entry, ix, opts),
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

function condenseContent(entry: LogEntry, ix: number, opts: CondenseOptions): unknown {
  if (isUserEntry(entry)) {
    const e = entry as UserEntry;
    if (typeof e.message.content === "string") {
      return maybeTruncateString(e.message.content, ix, opts);
    }
    return e.message.content.map((b) => condenseBlock(b, ix, opts));
  }
  if (isAssistantEntry(entry)) {
    const e = entry as AssistantEntry;
    return e.message.content.map((b) => condenseBlock(b, ix, opts));
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
    return {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      result: condenseToolResultContent(block.content, opts),
    };
  }
  // Text/thinking/image: pass through, but truncate large text
  const anyBlock = block as Record<string, unknown>;
  if (anyBlock.type === "text" && typeof anyBlock.text === "string") {
    return { type: "text", text: maybeTruncateString(anyBlock.text, ix, opts) };
  }
  return block;
}

function condenseToolInput(
  input: unknown,
  ix: number,
  opts: CondenseOptions
): unknown {
  if (input === null || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  let truncatedAny = false;
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string" && byteLength(v) > opts.maxInlineBytes) {
      truncatedAny = true;
      out[k] = "<<truncated>>";
    } else {
      out[k] = v;
    }
  }
  if (truncatedAny) {
    out._truncated = true;
    out._ref = `turns/${String(ix).padStart(5, "0")}.json`;
    out._bytes = byteLength(JSON.stringify(input));
    out._tokens_est = estTokens(out._bytes as number);
    out._preview = makePreview(input, opts.previewChars ?? 500);
  }
  return out;
}

function condenseToolResultContent(
  content: unknown,
  opts: CondenseOptions
): unknown {
  // String tool_result content may be a <persisted-output> wrapper
  if (typeof content === "string") {
    const persisted = parsePersistedOutput(content);
    if (persisted) {
      const fileName = persisted.filePath.split("/").pop() ?? "spill.txt";
      return {
        truncated: true,
        ref: `spill/${fileName}`,
        bytes: byteLength(content),
        tokens_est: estTokens(byteLength(content)),
        preview: persisted.preview,
      } satisfies RehydrationStub;
    }
    if (byteLength(content) > opts.maxInlineBytes) {
      return inlineStringStub(content, opts);
    }
    return content;
  }
  // Array of content blocks — leave structure, truncate any large text blocks
  if (Array.isArray(content)) {
    return content.map((b) => {
      const anyB = b as Record<string, unknown>;
      if (anyB.type === "text" && typeof anyB.text === "string" && byteLength(anyB.text) > opts.maxInlineBytes) {
        return { type: "text", text: inlineStringStub(anyB.text, opts) };
      }
      return b;
    });
  }
  return content;
}

function maybeTruncateString(text: string, ix: number, opts: CondenseOptions): unknown {
  if (byteLength(text) <= opts.maxInlineBytes) return text;
  return {
    truncated: true,
    ref: `turns/${String(ix).padStart(5, "0")}.json`,
    bytes: byteLength(text),
    tokens_est: estTokens(byteLength(text)),
    preview: makePreview(text, opts.previewChars ?? 500),
  } satisfies RehydrationStub;
}

function inlineStringStub(text: string, opts: CondenseOptions): RehydrationStub {
  return {
    truncated: true,
    ref: "(inline)",
    bytes: byteLength(text),
    tokens_est: estTokens(byteLength(text)),
    preview: makePreview(text, opts.previewChars ?? 500),
  };
}

function byteLength(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function estTokens(bytes: number): number {
  // Rough estimate: ~4 bytes per token.
  return Math.round(bytes / 4);
}

function extractTokens(entry: AssistantEntry): CondensedEntry["tokens"] {
  const u = entry.message.usage;
  const tokens: NonNullable<CondensedEntry["tokens"]> = {
    in: u.input_tokens,
    out: u.output_tokens,
  };
  if (u.cache_read_input_tokens !== undefined) tokens.cache_read = u.cache_read_input_tokens;
  if (u.cache_creation_input_tokens !== undefined) tokens.cache_write = u.cache_creation_input_tokens;
  return tokens;
}
