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

/** CC session IDs are always UUIDs. Reject anything that isn't so path joins stay safe. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Snapshot the source session's tasks dir into the new (compacted) session's
 * tasks dir so the compacted session starts with the same task state.
 *
 * **Copy, not symlink.** The source session may still be resumed/forked
 * independently of the compacted one; sharing on-disk task state (via a
 * symlink) would mean `TaskUpdate`s from either side mutate the other's
 * state. Copying gives each session its own independent task lifecycle
 * from compaction time onward. Symlinks *inside* the source tasks tree
 * are dereferenced (real file content gets copied) for the same reason.
 *
 * No-op when the source has no tasks dir. Throws if the destination
 * already exists — the caller owns uniqueness of `newSessionId` and
 * should re-roll if it sees a collision, rather than this function
 * silently stomping real state.
 */
export async function copyTasksDir(opts: CopyTasksOptions): Promise<CopyTasksResult> {
  // Path-traversal guard. session IDs flow from parsed JSONL; a crafted
  // file could set origSessionId to e.g. "../../etc" and coerce fs.cp() to
  // copy outside the tasks root. CC never emits non-UUID IDs, so rejecting
  // non-UUIDs is strictly safe.
  if (!UUID_RE.test(opts.origSessionId)) {
    throw new Error(`copyTasksDir: refusing non-UUID origSessionId: ${opts.origSessionId}`);
  }
  if (!UUID_RE.test(opts.newSessionId)) {
    throw new Error(`copyTasksDir: refusing non-UUID newSessionId: ${opts.newSessionId}`);
  }

  const baseDir = path.resolve(opts.tasksBaseDir ?? defaultTasksDir());
  const sourceTasksDir = await findTasksDir(opts.origSessionId, baseDir);
  if (!sourceTasksDir) return { copiedTo: null, source: null };

  // Post-resolve containment check — belt-and-suspenders given the UUID
  // guard above, but cheap and makes the invariant explicit.
  const resolvedSource = path.resolve(sourceTasksDir);
  if (!resolvedSource.startsWith(`${baseDir}${path.sep}`) && resolvedSource !== baseDir) {
    throw new Error(`copyTasksDir: source path escapes tasksBaseDir: ${resolvedSource}`);
  }

  const destDir = path.resolve(path.join(baseDir, opts.newSessionId));
  await mkdir(baseDir, { recursive: true });

  // `cp` with `force: false` + `errorOnExist: true` refuses to overwrite,
  // which is what we want — the caller must have verified the destination
  // is free before calling in. `dereference: true` copies the real content
  // of any symlinks inside the source tree so the snapshot is a standalone
  // state rather than a tangle of pointers back into the source.
  await cp(resolvedSource, destDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
    dereference: true,
  });

  return { copiedTo: destDir, source: resolvedSource };
}
