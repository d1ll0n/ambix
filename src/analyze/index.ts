// src/analyze/index.ts
import type { Session } from "parse-claude-logs";
import type { AnalyzeResult } from "./types.js";
import { aggregateTokens } from "./tokens.js";
import { aggregateToolUse } from "./tool-aggregates.js";
import { clusterBashCommands } from "./bash-clusters.js";
import { buildFileChurnTimeline } from "./file-churn.js";
import { collectFailures } from "./failures.js";
import { buildTokenDensityTimeline } from "./token-density.js";
import { crossReferenceSubagents } from "./subagents.js";
import { inventorySpills } from "./spills.js";
import { collectPermissionEvents } from "./permissions.js";

export * from "./types.js";

/**
 * Top-level deterministic analysis composition. Runs every pass
 * against the session and returns a fully-populated `AnalyzeResult`.
 */
export async function analyze(session: Session): Promise<AnalyzeResult> {
  const entries = await session.messages();

  const tokens = await aggregateTokens(session);
  const { tools, files } = aggregateToolUse(entries);
  const bash_clusters = clusterBashCommands(entries);
  const churn_timeline = buildFileChurnTimeline(entries);
  const failures = collectFailures(entries);
  const token_density_timeline = buildTokenDensityTimeline(entries);
  const subagents = await crossReferenceSubagents(session);
  const spill_files = inventorySpills(entries);
  const permission_events = collectPermissionEvents(entries);

  const compaction = await session.compaction();

  return {
    tokens,
    tools,
    files,
    churn_timeline,
    bash_clusters,
    failures,
    compaction_phases: compaction.phases,
    subagents,
    spill_files,
    token_density_timeline,
    permission_events,
  };
}
