// src/compact-session/types.ts
import type { LogEntry } from "parse-cc";

/** Options for `compactSession`. */
export interface CompactSessionOptions {
  /**
   * Preserve the last N rounds verbatim (full tool_result bodies). Older
   * turns are condensed — their tool_result `content` fields are replaced
   * with a stub string pointing at `ambix query <orig-session-id> <ix>`.
   * Default: 10.
   */
  fullRecent?: number;
  /**
   * Destination path for the compacted JSONL. If omitted, defaults to
   * `~/.claude/projects/<source-slug>/<new-uuid>.jsonl` so CC's `/resume`
   * picks it up in the source's cwd.
   */
  output?: string;
  /**
   * Don't write anything to disk; return the plan with stats only. Useful
   * for previewing before committing.
   */
  dryRun?: boolean;
  /**
   * Override the tasks root directory (defaults to parse-cc's
   * `defaultTasksDir()`, i.e. `~/.claude/tasks`). Testing seam only —
   * real callers should leave this undefined.
   */
  tasksBaseDir?: string;
}

/** Result of a compact-session run. */
export interface CompactSessionResult {
  /** Fresh UUID assigned to the new compacted session. */
  newSessionId: string;
  /** Absolute path the JSONL was written to (or would be, in dry-run). */
  destPath: string;
  /** True if writes were skipped because `dryRun` was set. */
  dryRun: boolean;
  /**
   * Absolute path to the snapshotted tasks dir copied for the new session,
   * or null if the source had no tasks dir (or we were in dry-run).
   */
  copiedTasksDir: string | null;
  /** Per-section counts and byte estimates. */
  stats: CompactSessionStats;
}

/** Per-section telemetry. */
export interface CompactSessionStats {
  /** Total source entries walked. */
  sourceEntryCount: number;
  /** Entries emitted in the condensed (pre-divider) section. */
  condensedEntryCount: number;
  /** Entries emitted in the preserved (post-divider) section. */
  preservedEntryCount: number;
  /** Number of tool_result bodies replaced with stubs in the condensed section. */
  stubbedToolResultCount: number;
  /**
   * Number of oversized string fields truncated inside condensed assistant
   * entries' tool_use inputs (Edit old/new_string, Write content, arbitrary
   * fields in unknown-shape tools).
   */
  truncatedInputFieldCount: number;
  /**
   * Rough bytes removed (sum of original content sizes minus replacement
   * sizes, across tool_result stubs and tool_use input truncations).
   * Positive = savings.
   */
  bytesSaved: number;
}

/** An entry destined for the compacted output, already fully rewritten. */
export type EmittedEntry = LogEntry;
