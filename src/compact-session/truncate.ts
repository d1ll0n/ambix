// src/compact-session/truncate.ts

export interface TruncateOptions {
  /** Any string whose UTF-8 byte length exceeds this gets replaced. */
  maxFieldBytes: number;
  /** Replacement string substituted for oversized values. Should reference rehydration. */
  marker: string;
}

export interface TruncateStats {
  truncatedFieldCount: number;
  bytesSaved: number;
}

/**
 * Recursively walk a JSON-like value and replace every string whose UTF-8
 * byte length exceeds `maxFieldBytes` with `marker`. Walks into arrays and
 * plain objects; leaves numbers, booleans, null untouched. Strings at or
 * below the threshold are preserved verbatim.
 *
 * Mutates the input tree. Callers should JSON-clone first if mutation
 * would affect shared state.
 *
 * Use to defend against unknown shapes (MCP tools, new tool types, arbitrary
 * fields) that might carry multi-KB payloads where we don't have a specific
 * condenser. Call this after applying any tool-specific stubbing so the
 * sweep catches anything the specific passes missed.
 */
export function truncateOversizedStrings(
  value: unknown,
  opts: TruncateOptions,
  stats: TruncateStats
): unknown {
  if (typeof value === "string") {
    const bytes = Buffer.byteLength(value, "utf8");
    if (bytes > opts.maxFieldBytes) {
      stats.truncatedFieldCount += 1;
      stats.bytesSaved += Math.max(0, bytes - Buffer.byteLength(opts.marker, "utf8"));
      return opts.marker;
    }
    return value;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = truncateOversizedStrings(value[i], opts, stats);
    }
    return value;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      obj[k] = truncateOversizedStrings(obj[k], opts, stats);
    }
    return value;
  }
  return value;
}
