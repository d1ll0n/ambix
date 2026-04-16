// src/analyze/types.ts
import type { CompactionPhase } from "parse-cc";

/** Per-model token breakdown, with message count. */
export interface ModelTokens {
  in: number;
  out: number;
  cache_read: number;
  cache_write: number;
  message_count: number;
}

/** Session-wide token rollup. */
export interface TokensSummary {
  by_model: Record<string, ModelTokens>;
  totals: {
    in: number;
    out: number;
    cache_read: number;
    cache_write: number;
  };
}

/** Aggregated tool call counts. */
export interface ToolsSummary {
  invocations: Record<string, number>;
}

/** Read/Write/Edit counts for a single file path. */
export interface FileRecord {
  path: string;
  reads: number;
  edits: number;
  writes: number;
}

/** Per-file aggregated view of tool activity. */
export interface FilesSummary {
  touched: FileRecord[];
  read_without_write: string[];
}

/** Ordered event stream for one file. */
export interface ChurnRecord {
  path: string;
  events: Array<{ ix: number; kind: "read" | "edit" | "write" }>;
}

/** A cluster of Bash invocations sharing a first-token pattern. */
export interface BashCluster {
  pattern: string;
  count: number;
  examples_ix: number[];
}

/** A single failed tool call. */
export interface FailureRecord {
  ix: number;
  tool: string;
  tool_use_id: string;
  input: unknown;
  error: string;
}

/** Cross-reference record tying a parent Task tool_use to a subagent file. */
export interface SubagentRecord {
  agent_id: string;
  parent_ix: number | null;
  subagent_type: string | null;
  turn_count: number;
  tokens: { in: number; out: number };
}

/** One persisted-output spill reference. */
export interface SpillRecord {
  tool_use_id: string;
  owning_ix: number;
  file_path: string;
  size_label: string;
}

/** Permission-mode change or hook-related attachment. */
export interface PermissionEvent {
  ix: number;
  kind: string;
  details: unknown;
}

/** Full deterministic analysis output. */
export interface AnalyzeResult {
  tokens: TokensSummary;
  tools: ToolsSummary;
  files: FilesSummary;
  churn_timeline: ChurnRecord[];
  bash_clusters: BashCluster[];
  failures: FailureRecord[];
  compaction_phases: CompactionPhase[];
  subagents: SubagentRecord[];
  spill_files: SpillRecord[];
  token_density_timeline: Array<[number, number]>;
  permission_events: PermissionEvent[];
}
