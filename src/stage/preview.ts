// src/stage/preview.ts

/**
 * Build a deterministic preview of a value, capped at `maxChars`.
 *
 * For strings, returns the value truncated. For objects, returns a
 * stable JSON serialization (keys sorted) truncated. For null/undefined,
 * returns an empty string.
 *
 * Truncated outputs end with " …[truncated]" so callers can detect them.
 */
export function makePreview(value: unknown, maxChars: number): string {
  if (value === null || value === undefined) return "";
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    text = stableStringify(value);
  }
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)} …[truncated]`;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        sorted[k] = (v as Record<string, unknown>)[k];
      }
      return sorted;
    }
    return v;
  });
}
