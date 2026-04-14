// src/query/types.ts

/** A single result row returned by a query handler. */
export interface QueryMatch {
  /** Session-local turn index this match lives in. */
  ix: number;
  /** "tool_use" | "tool_result" | "text" | "thinking" | "other" */
  kind: string;
  /** Short one-line human-readable summary of the match. */
  summary: string;
  /** Optional extra data for --full JSON output. */
  raw?: unknown;
}

/** Output format for query results. */
export type QueryOutputFormat = "compact" | "full" | "count";
