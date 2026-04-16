// src/stage/condense.ts
import type { AssistantEntry, ContentBlock, LogEntry, UserEntry } from "parse-cc";
import {
  isAssistantEntry,
  isAttachmentEntry,
  isSummaryEntry,
  isSystemEntry,
  isTextBlock,
  isThinkingBlock,
  isToolResultBlock,
  isToolUseBlock,
  isUserEntry,
  parsePersistedOutput,
} from "parse-cc";
import type { CondensedEntry, RehydrationStub } from "../types.js";

/** Options controlling condensation. */
export interface CondenseOptions {
  /** Inline content larger than this (in bytes of JSON) becomes a stub. */
  maxInlineBytes: number;
  /** Preview length for truncated content. */
  previewChars?: number;
}

/** One row of the post-condensation report, bucketed by content kind. */
export interface CondenseStatsRow {
  /** Bucket label, e.g. "tool_use:Bash", "tool_result:Read", "assistant:text". */
  kind: string;
  /** Number of blocks / entries that contributed to this bucket. */
  count: number;
  /** Sum of JSON-serialized byte size of the source blocks. */
  origBytes: number;
  /** Sum of JSON-serialized byte size of the condensed output for those blocks. */
  inlinedBytes: number;
  /** Number of items in this bucket that had ≥1 truncation stub in their condensed form. */
  truncatedCount: number;
}

/** Full report returned alongside condensed entries. */
export interface CondenseStats {
  rows: CondenseStatsRow[];
  totals: {
    count: number;
    origBytes: number;
    inlinedBytes: number;
    truncatedCount: number;
  };
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

/** Internal context threaded through the condensation helpers. */
interface CondenseCtx {
  opts: CondenseOptions;
  uuidToIx: Map<string, number>;
  toolUseIdToName: Map<string, string>;
  stats: StatsBuckets | null;
}

/** Mutable stats accumulator. Null when stats aren't requested. */
class StatsBuckets {
  private buckets = new Map<string, CondenseStatsRow>();

  record(kind: string, origBytes: number, inlinedBytes: number, truncated: boolean): void {
    let row = this.buckets.get(kind);
    if (!row) {
      row = { kind, count: 0, origBytes: 0, inlinedBytes: 0, truncatedCount: 0 };
      this.buckets.set(kind, row);
    }
    row.count += 1;
    row.origBytes += origBytes;
    row.inlinedBytes += inlinedBytes;
    if (truncated) row.truncatedCount += 1;
  }

  finalize(): CondenseStats {
    const rows = Array.from(this.buckets.values());
    rows.sort((a, b) => b.origBytes - a.origBytes);
    const totals = rows.reduce(
      (acc, r) => ({
        count: acc.count + r.count,
        origBytes: acc.origBytes + r.origBytes,
        inlinedBytes: acc.inlinedBytes + r.inlinedBytes,
        truncatedCount: acc.truncatedCount + r.truncatedCount,
      }),
      { count: 0, origBytes: 0, inlinedBytes: 0, truncatedCount: 0 }
    );
    return { rows, totals };
  }
}

/** Convert LogEntry[] into the condensed format with truncation stubs. */
export function condenseEntries(
  entries: ReadonlyArray<LogEntry>,
  opts: CondenseOptions
): CondensedEntry[] {
  return runCondense(entries, opts, false).entries;
}

/** Same as `condenseEntries` but also returns per-kind condensation stats. */
export function condenseEntriesWithStats(
  entries: ReadonlyArray<LogEntry>,
  opts: CondenseOptions
): { entries: CondensedEntry[]; stats: CondenseStats } {
  const result = runCondense(entries, opts, true);
  return { entries: result.entries, stats: result.stats! };
}

function runCondense(
  entries: ReadonlyArray<LogEntry>,
  opts: CondenseOptions,
  collectStats: boolean
): { entries: CondensedEntry[]; stats: CondenseStats | null } {
  const uuidToIx = new Map<string, number>();
  const toolUseIdToName = new Map<string, string>();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const u = (e as { uuid?: string }).uuid;
    if (u) uuidToIx.set(u, i);
    // Prepopulate tool_use_id -> name map so tool_result stats can be
    // attributed to the right tool.
    if (isAssistantEntry(e)) {
      for (const block of (e as AssistantEntry).message.content) {
        if (isToolUseBlock(block)) {
          toolUseIdToName.set(block.id, block.name);
        }
      }
    }
  }

  const ctx: CondenseCtx = {
    opts,
    uuidToIx,
    toolUseIdToName,
    stats: collectStats ? new StatsBuckets() : null,
  };

  const out: CondensedEntry[] = [];
  for (let i = 0; i < entries.length; i++) {
    out.push(condenseOne(entries[i], i, ctx));
  }
  return { entries: out, stats: ctx.stats ? ctx.stats.finalize() : null };
}

/**
 * Recursively walk a value and replace any string field larger than
 * `ctx.opts.maxInlineBytes` with a truncation stub. Returns a new
 * value (does not mutate the input). Used for non-message entry
 * payloads (attachment, system, summary, last-prompt, etc.), for
 * image block base64 data, and for the tool_result catch-all branch.
 */
function truncateLargeStringsDeep(value: unknown, ix: number, ctx: CondenseCtx): unknown {
  if (typeof value === "string") {
    if (byteLength(value) <= ctx.opts.maxInlineBytes) return value;
    return makeStub(
      `turns/${String(ix).padStart(5, "0")}.json`,
      value,
      value.slice(0, ctx.opts.previewChars ?? 500)
    );
  }
  if (Array.isArray(value)) {
    return value.map((v) => truncateLargeStringsDeep(v, ix, ctx));
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateLargeStringsDeep(v, ix, ctx);
    }
    return out;
  }
  return value;
}

function condenseOne(entry: LogEntry, ix: number, ctx: CondenseCtx): CondensedEntry {
  const uuid = (entry as { uuid?: string }).uuid ?? "";
  const parentUuid = (entry as { parentUuid?: string | null }).parentUuid ?? null;
  const ts = (entry as { timestamp?: string }).timestamp ?? null;

  const condensed: CondensedEntry = {
    ix,
    ref: uuid ? `uuid:${uuid}` : `ix:${ix}`,
    parent_ix: parentUuid ? (ctx.uuidToIx.get(parentUuid) ?? null) : null,
    role: roleOf(entry),
    type: entry.type,
    ts,
    content: extractContent(entry, ix, ctx),
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
function extractContent(entry: LogEntry, ix: number, ctx: CondenseCtx): unknown {
  if (isUserEntry(entry)) {
    const e = entry as UserEntry;
    if (typeof e.message.content === "string") {
      const stats = ctx.stats;
      const raw = e.message.content;
      const condensed = maybeStub(raw, ix, ctx);
      if (stats) {
        const orig = byteLength(raw);
        const inlined = jsonBytes(condensed);
        stats.record("user:text", orig, inlined, containsStub(condensed));
      }
      return condensed;
    }
    return e.message.content.map((b) => condenseBlock(b, ix, ctx, true));
  }

  if (isAssistantEntry(entry)) {
    const e = entry as AssistantEntry;
    return e.message.content.map((b) => condenseBlock(b, ix, ctx, true));
  }

  // All other known and unknown entry types: preserve payload minus metadata
  // fields, then deep-truncate any large string fields inside the payload
  // (e.g. skill_listing.content, hook_success.stdout, summary.summary,
  // last-prompt.lastPrompt). Record them under an "other:<type>" bucket.
  const rawPayload = preservedEntryPayload(entry);
  const origBytes = jsonBytes(rawPayload);
  const payload = truncateLargeStringsDeep(rawPayload, ix, ctx);
  if (ctx.stats) {
    const inlinedBytes = jsonBytes(payload);
    ctx.stats.record(`other:${entry.type}`, origBytes, inlinedBytes, containsStub(payload));
  }
  return payload;
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

/**
 * Block-level condensation for user/assistant content arrays.
 *
 * `recordStats` is true only when this block is being condensed as a
 * direct child of a message's `content` array. When called recursively
 * from `condenseToolResultContent` (where a tool_result's content is
 * itself an array of blocks), `recordStats` is false so we don't
 * double-count: the outer `tool_result:<name>` bucket already records
 * the full JSON bytes of the wrapping tool_result block.
 */
function condenseBlock(
  block: ContentBlock,
  ix: number,
  ctx: CondenseCtx,
  recordStats: boolean
): unknown {
  if (isToolUseBlock(block)) {
    const condensed = {
      type: "tool_use" as const,
      id: block.id,
      name: block.name,
      input: condenseToolInput(block.input, ix, ctx),
    };
    if (recordStats && ctx.stats) {
      const orig = jsonBytes(block);
      const inlined = jsonBytes(condensed);
      ctx.stats.record(`tool_use:${block.name}`, orig, inlined, containsStub(condensed.input));
    }
    return condensed;
  }

  if (isToolResultBlock(block)) {
    const result: Record<string, unknown> = {
      type: "tool_result",
      tool_use_id: block.tool_use_id,
      result: condenseToolResultContent(block.content, ix, ctx),
    };
    if (block.is_error) {
      result.is_error = true;
    }
    if (recordStats && ctx.stats) {
      const toolName = ctx.toolUseIdToName.get(block.tool_use_id) ?? "<unknown>";
      const orig = jsonBytes(block);
      const inlined = jsonBytes(result);
      ctx.stats.record(`tool_result:${toolName}`, orig, inlined, containsStub(result.result));
    }
    return result;
  }

  if (isTextBlock(block)) {
    const condensed = { type: "text", text: maybeStub(block.text, ix, ctx) };
    if (recordStats && ctx.stats) {
      const orig = jsonBytes(block);
      const inlined = jsonBytes(condensed);
      ctx.stats.record("assistant:text", orig, inlined, containsStub(condensed.text));
    }
    return condensed;
  }

  if (isThinkingBlock(block)) {
    // Stub the `signature` field (an encrypted, opaque blob that the
    // distiller agent can't usefully interpret) when it exceeds the
    // inline budget. The `thinking` text itself is the agent-visible
    // reasoning and is handled via maybeStub.
    const rawSignature = (block as { signature?: string }).signature;
    const out: Record<string, unknown> = {
      type: "thinking",
      thinking: maybeStub(block.thinking, ix, ctx),
    };
    if (rawSignature !== undefined) {
      out.signature =
        typeof rawSignature === "string" ? maybeStub(rawSignature, ix, ctx) : rawSignature;
    }
    if (recordStats && ctx.stats) {
      const orig = jsonBytes(block);
      const inlined = jsonBytes(out);
      ctx.stats.record(
        "assistant:thinking",
        orig,
        inlined,
        containsStub(out.thinking) || containsStub(out.signature)
      );
    }
    return out;
  }

  // image blocks: stub the `source.data` base64 payload if present.
  if ((block as { type?: string }).type === "image") {
    const img = block as {
      type: "image";
      source?: { type?: string; media_type?: string; data?: unknown };
    };
    const condensedImage: Record<string, unknown> = { type: "image" };
    if (img.source) {
      const { type, media_type, data } = img.source;
      condensedImage.source = {
        ...(type !== undefined ? { type } : {}),
        ...(media_type !== undefined ? { media_type } : {}),
        data:
          typeof data === "string"
            ? maybeStub(data, ix, ctx)
            : truncateLargeStringsDeep(data, ix, ctx),
      };
    }
    if (recordStats && ctx.stats) {
      const orig = jsonBytes(block);
      const inlined = jsonBytes(condensedImage);
      ctx.stats.record("assistant:image", orig, inlined, containsStub(condensedImage));
    }
    return condensedImage;
  }

  // Unknown block shape: deep-walk to catch any unbounded string fields.
  const walked = truncateLargeStringsDeep(block, ix, ctx);
  if (recordStats && ctx.stats) {
    const orig = jsonBytes(block);
    const inlined = jsonBytes(walked);
    ctx.stats.record(
      `block:${(block as { type?: string }).type ?? "unknown"}`,
      orig,
      inlined,
      containsStub(walked)
    );
  }
  return walked;
}

/**
 * Per-field truncation for tool_use inputs.
 * Small fields stay inline; large string fields become stubs.
 */
function condenseToolInput(input: unknown, ix: number, ctx: CondenseCtx): unknown {
  if (input === null || typeof input !== "object") return input;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (typeof v === "string" && byteLength(v) > ctx.opts.maxInlineBytes) {
      out[k] = makeStub(
        `turns/${String(ix).padStart(5, "0")}.json`,
        v,
        v.slice(0, ctx.opts.previewChars ?? 500)
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
function condenseToolResultContent(content: unknown, ix: number, ctx: CondenseCtx): unknown {
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
    if (byteLength(content) > ctx.opts.maxInlineBytes) {
      return makeStub(
        `turns/${String(ix).padStart(5, "0")}.json`,
        content,
        content.slice(0, ctx.opts.previewChars ?? 500)
      );
    }
    return content;
  }

  if (Array.isArray(content)) {
    // recordStats=false: the outer tool_result block already records the
    // full payload bytes under tool_result:<name>. Recording stats for
    // each inner block would double-count.
    return (content as ContentBlock[]).map((b) => condenseBlock(b, ix, ctx, false));
  }

  // Catch-all: non-string, non-array content (e.g. an object shape we
  // don't model). Deep-walk for any large string fields so nothing
  // unbounded passes through untruncated.
  return truncateLargeStringsDeep(content, ix, ctx);
}

/** String → string or stub. Used for text blocks, thinking blocks, user string content. */
function maybeStub(value: unknown, ix: number, ctx: CondenseCtx): unknown {
  if (typeof value !== "string") return value;
  if (byteLength(value) <= ctx.opts.maxInlineBytes) return value;
  return makeStub(
    `turns/${String(ix).padStart(5, "0")}.json`,
    value,
    value.slice(0, ctx.opts.previewChars ?? 500)
  );
}

/** Build a uniform RehydrationStub. */
function makeStub(ref: string, full: string, preview: string): RehydrationStub {
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

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

/** True if value (or any nested value) is a truncation stub. */
function containsStub(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if ((value as { truncated?: boolean }).truncated === true) return true;
  if (Array.isArray(value)) {
    for (const v of value) if (containsStub(v)) return true;
    return false;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (containsStub(v)) return true;
  }
  return false;
}

function estTokens(bytes: number): number {
  return Math.round(bytes / 4);
}
