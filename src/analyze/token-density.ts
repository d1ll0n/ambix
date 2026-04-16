// src/analyze/token-density.ts
import type { LogEntry } from "parse-cc";
import { isAssistantEntry } from "parse-cc";

/**
 * Produce an ordered series of `[ix, total_tokens]` for each
 * non-synthetic assistant entry. Total is input + output (excludes
 * cache tokens since those aren't what drove per-turn cost spikes).
 */
export function buildTokenDensityTimeline(
  entries: ReadonlyArray<LogEntry>
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let ix = 0; ix < entries.length; ix++) {
    const entry = entries[ix];
    if (!isAssistantEntry(entry)) continue;
    if (entry.message.model === "<synthetic>") continue;
    const u = entry.message.usage;
    out.push([ix, u.input_tokens + u.output_tokens]);
  }
  return out;
}
