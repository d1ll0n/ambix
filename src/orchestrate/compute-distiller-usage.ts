// src/orchestrate/compute-distiller-usage.ts
import { access, readdir } from "node:fs/promises";
import path from "node:path";
import { Session } from "parse-cc";
import { aggregateTokens } from "../analyze/tokens.js";

/** Authoritative distiller token totals. All fields default to 0. */
export interface DistillerUsageTotals {
  in: number;
  out: number;
  cache_read: number;
  cache_write: number;
}

/**
 * Walk every `.jsonl` file at the top level of `distillerLogDir`,
 * parse each via `parse-cc`' `Session` class, and sum the
 * aggregated token usage across them.
 *
 * Returns `null` when the directory doesn't exist or has no `.jsonl`
 * files. Returns zero totals when the files exist but carry no
 * assistant entries (e.g. a distillation that failed before the
 * agent made any API calls).
 *
 * This is the authoritative source of the distiller's own token
 * usage because the SDK adapter's `SDKResultMessage.usage` field
 * does NOT aggregate across multi-turn conversations (observed
 * ~3x undercount). Walking the captured session log fixes that.
 */
export async function computeDistillerUsageFromLog(
  distillerLogDir: string
): Promise<DistillerUsageTotals | null> {
  try {
    await access(distillerLogDir);
  } catch {
    return null;
  }

  let entries: string[];
  try {
    const all = await readdir(distillerLogDir);
    entries = all.filter((n) => n.endsWith(".jsonl"));
  } catch {
    return null;
  }
  if (entries.length === 0) return null;

  const totals: DistillerUsageTotals = { in: 0, out: 0, cache_read: 0, cache_write: 0 };

  for (const fileName of entries) {
    const filePath = path.join(distillerLogDir, fileName);
    try {
      const session = new Session(filePath);
      const summary = await aggregateTokens(session);
      totals.in += summary.totals.in;
      totals.out += summary.totals.out;
      totals.cache_read += summary.totals.cache_read;
      totals.cache_write += summary.totals.cache_write;
    } catch {
      // Skip malformed files rather than failing the whole computation
    }
  }

  return totals;
}
