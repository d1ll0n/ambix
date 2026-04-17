// src/compact-session/types.ts
import type { LogEntry } from "parse-cc";

/**
 * How the condensed (pre-preserved-tail) section is represented.
 *
 * - `bundled` — everything collapses into ONE user-role message containing
 *   an `<ambix-compaction-marker>` preamble plus an XML list of per-turn
 *   summaries. Tiny, simpler for the agent, but loses per-entry structural
 *   fidelity. Task* entries still pass through as real entries so CC can
 *   rebuild its live task list on resume. Default.
 *
 * - `structural` — every condensed entry remains a real log entry with its
 *   role preserved; tool_result bodies are swapped for rehydration stubs
 *   and oversized string fields are truncated. Bigger but keeps the
 *   transcript parseable by downstream tooling.
 */
export type CompactMode = "bundled" | "structural";

/** Options for `compactSession`. */
export interface CompactSessionOptions {
  /** Render mode. Default: `"bundled"`. */
  mode?: CompactMode;
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
  /**
   * UTF-8 byte threshold above which a string field in the condensed
   * section gets replaced with a truncation marker (plus a short preview).
   * Default: 500.
   */
  maxFieldBytes?: number;
  /**
   * Number of chars of the original field to keep as a preview inside
   * `<truncated>…</truncated>` tags before the truncation marker. Set to
   * 0 to disable previews. Default: 100.
   */
  previewChars?: number;
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
  /**
   * Source entries dropped entirely from the condensed section
   * (`file-history-snapshot` bookkeeping that CC never feeds to the model).
   */
  droppedEntryCount: number;
  /** Number of tool_result bodies replaced with stubs in the condensed section. */
  stubbedToolResultCount: number;
  /**
   * Number of oversized string fields truncated inside condensed assistant
   * entries' tool_use inputs (Edit old/new_string, Write content, arbitrary
   * fields in unknown-shape tools).
   */
  truncatedInputFieldCount: number;
  /**
   * Bundled-mode only: source entries collapsed into the single bundled
   * user-message summary (i.e. everything that wasn't preserved, dropped,
   * or passed through as a Task* entry). Always 0 in structural mode.
   */
  bundledTurnCount: number;
  /**
   * Bundled-mode only: entries containing both a Task* tool_use/tool_result
   * AND non-Task content in the same entry. These pass through verbatim
   * (the whole entry can't be cleanly split across the bundle boundary),
   * which means non-Task content in them bypasses condensation. Typically
   * zero or very small — non-zero values suggest the mixed-block case is
   * common enough to warrant block-level splitting.
   */
  mixedPreservedEntryCount: number;
  /**
   * Rough bytes removed (sum of original content sizes minus replacement
   * sizes, across tool_result stubs and tool_use input truncations).
   * Positive = savings.
   */
  bytesSaved: number;
}

/** An entry destined for the compacted output, already fully rewritten. */
export type EmittedEntry = LogEntry;
