// src/types.ts

/**
 * A single entry in the condensed session.jsonl produced by ambix's
 * staging step. Mirrors the source LogEntry shape as much as possible,
 * with these additions:
 *   - `ix`: session-local numeric index (used as the canonical reference
 *           in the final artifact's narrative)
 *   - `ref`: original entry uuid for post-processing resolution
 *   - large payloads are replaced by RehydrationStub objects inline
 */
export interface CondensedEntry {
  ix: number;
  ref: string;
  parent_ix: number | null;
  role: "user" | "assistant" | "system" | "summary" | "attachment" | "other";
  type: string;
  ts: string | null;
  synthetic?: boolean;
  tokens?: {
    in: number;
    out: number;
    cache_read?: number;
    cache_write?: number;
  };
  content: unknown;
}

/**
 * Inline replacement for a payload that was too large to embed in
 * the condensed log. The agent decides whether to rehydrate via Read.
 */
export interface RehydrationStub {
  truncated: true;
  ref: string;
  bytes: number;
  tokens_est: number;
  preview: string;
}

/** Structural metadata written to <tmp>/metadata.json. */
export interface MetadataJson {
  session_id: string;
  source_path: string;
  version: string | null;
  cwd: string | null;
  git_branch: string | null;
  permission_mode: string | null;
  start_ts: string | null;
  end_ts: string | null;
  duration_s: number | null;
  turn_count: number;
  end_state: "completed" | "ongoing" | "unknown";
  /**
   * Map from local tmp-relative session.jsonl paths to the absolute raw
   * Claude Code log files. Used by `bin/query` to resolve local paths
   * the agent passes (e.g. "session.jsonl" or
   * "subagents/agent-<uuid>/session.jsonl") back to the raw files that
   * parse-cc' Session class can parse. The agent never sees
   * the raw paths directly — they stay out of the filesystem view.
   */
  query_targets: Record<string, string>;
}

/** Per-file timeline written to <tmp>/file-history/snapshots.json. */
export interface SnapshotsIndex {
  files: Array<{
    path: string;
    versions: Array<{
      version: number;
      ix: number; // first ix at which this version was observed
      backup_time: string;
      blob: string | null; // relative path under file-history/blobs/, or null
      bytes: number | null;
    }>;
  }>;
}

/** Description of a completed staging operation. */
export interface StageLayout {
  tmpDir: string;
  metadataPath: string;
  sessionPath: string;
  turnsDir: string;
  spillDir: string;
  subagentsDir: string;
  fileHistoryDir: string;
  outDir: string;
  binDir: string;
  truncatedIndices: number[];
  spillCount: number;
  subagentCount: number;
  /** Per-kind condensation stats. Present when staging collected them. */
  condenseStats?: import("./stage/condense.js").CondenseStats;
}
