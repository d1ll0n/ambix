// src/analyze/tokens.ts
import type { Session } from "parse-cc";
import { isAssistantEntry } from "parse-cc";
import type { ModelTokens, TokensSummary } from "./types.js";

/**
 * Sum token usage across all non-synthetic assistant entries, grouped
 * by model. Excludes `<synthetic>` model entries since those are
 * harness-generated and don't represent real API spend.
 */
export async function aggregateTokens(session: Session): Promise<TokensSummary> {
  const entries = await session.messages();
  const byModel: Record<string, ModelTokens> = {};
  const totals = { in: 0, out: 0, cache_read: 0, cache_write: 0 };

  for (const entry of entries) {
    if (!isAssistantEntry(entry)) continue;
    const model = entry.message.model;
    if (model === "<synthetic>") continue;

    const u = entry.message.usage;
    const inTok = u.input_tokens;
    const outTok = u.output_tokens;
    const cr = u.cache_read_input_tokens ?? 0;
    const cw = u.cache_creation_input_tokens ?? 0;

    if (!byModel[model]) {
      byModel[model] = { in: 0, out: 0, cache_read: 0, cache_write: 0, message_count: 0 };
    }
    byModel[model].in += inTok;
    byModel[model].out += outTok;
    byModel[model].cache_read += cr;
    byModel[model].cache_write += cw;
    byModel[model].message_count += 1;

    totals.in += inTok;
    totals.out += outTok;
    totals.cache_read += cr;
    totals.cache_write += cw;
  }

  return { by_model: byModel, totals };
}
