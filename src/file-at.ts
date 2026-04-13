// src/file-at.ts
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import type { SnapshotsIndex } from "./types.js";

/** Result of a file-at lookup. */
export interface FileAtResult {
  path: string;
  version: number;
  ix: number;
  content: string;
}

/** Arguments for `fileAt`. */
export interface FileAtArgs {
  /** Path to the staged tmp dir (the one containing file-history/snapshots.json). */
  tmp: string;
  /** The tracked file path as recorded in trackedFileBackups. */
  path: string;
  /** Session-local turn index. Returns the version current at-or-before this ix. */
  ix: number;
}

/**
 * Resolve a tracked file's content as it existed at a given turn index.
 *
 * Walks the staged file-history snapshots index to find the latest
 * version whose `ix` is at-or-before the requested `ix`, then reads
 * that version's blob.
 *
 * Throws a descriptive error when:
 *  - snapshots.json does not exist in the tmp dir
 *  - the file is not tracked at all
 *  - no version exists at-or-before the requested ix (file appeared later)
 *  - the resolved blob file is missing
 */
export async function fileAt(args: FileAtArgs): Promise<FileAtResult> {
  const indexPath = path.join(args.tmp, "file-history", "snapshots.json");
  try {
    await access(indexPath);
  } catch {
    throw new Error(`snapshots.json not found at ${indexPath}`);
  }

  const idx = JSON.parse(await readFile(indexPath, "utf8")) as SnapshotsIndex;
  const fileEntry = idx.files.find((f) => f.path === args.path);
  if (!fileEntry) {
    throw new Error(`file not tracked: ${args.path}`);
  }

  const sorted = [...fileEntry.versions].sort((a, b) => a.ix - b.ix);
  let chosen: typeof sorted[number] | null = null;
  for (const v of sorted) {
    if (v.ix <= args.ix) chosen = v;
    else break;
  }
  if (!chosen) {
    throw new Error(`no version of ${args.path} exists at-or-before ix=${args.ix}`);
  }
  if (!chosen.blob) {
    throw new Error(`version ${chosen.version} of ${args.path} has no stored blob`);
  }

  const blobPath = path.join(args.tmp, "file-history", chosen.blob);
  const content = await readFile(blobPath, "utf8");
  return {
    path: args.path,
    version: chosen.version,
    ix: chosen.ix,
    content,
  };
}
