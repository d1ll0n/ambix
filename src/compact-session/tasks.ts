// src/compact-session/tasks.ts
import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import { defaultTasksDir, findTasksDir } from "parse-cc";

export interface CopyTasksOptions {
  origSessionId: string;
  newSessionId: string;
  /** Override the tasks root. Defaults to parse-cc's `defaultTasksDir()`. */
  tasksBaseDir?: string;
}

export interface CopyTasksResult {
  /** Absolute path the new session's tasks dir was written to, or null when no copy was needed. */
  copiedTo: string | null;
  /** Absolute path of the source tasks dir that was copied. */
  source: string | null;
}

/**
 * Snapshot the source session's tasks dir into the new (compacted) session's
 * tasks dir so the compacted session starts with the same task state.
 *
 * **Copy, not symlink.** The source session may still be resumed/forked
 * independently of the compacted one; sharing on-disk task state (via a
 * symlink) would mean `TaskUpdate`s from either side mutate the other's
 * state. Copying gives each session its own independent task lifecycle
 * from compaction time onward.
 *
 * No-op when the source has no tasks dir. Throws if the destination
 * already exists — the caller owns uniqueness of `newSessionId` and
 * should re-roll if it sees a collision, rather than this function
 * silently stomping real state.
 */
export async function copyTasksDir(opts: CopyTasksOptions): Promise<CopyTasksResult> {
  const baseDir = opts.tasksBaseDir ?? defaultTasksDir();
  const sourceTasksDir = await findTasksDir(opts.origSessionId, baseDir);
  if (!sourceTasksDir) return { copiedTo: null, source: null };

  const destDir = path.join(baseDir, opts.newSessionId);
  await mkdir(baseDir, { recursive: true });

  // `cp` with `force: false` + `errorOnExist: true` refuses to overwrite,
  // which is what we want — the caller must have verified the destination
  // is free before calling in.
  await cp(sourceTasksDir, destDir, { recursive: true, force: false, errorOnExist: true });

  return { copiedTo: destDir, source: path.resolve(sourceTasksDir) };
}
