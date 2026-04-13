// src/orchestrate/tmp.ts
import { mkdir, rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";

/** Options for creating a tmp workspace. */
export interface MakeTmpOptions {
  root: string;
  sessionId: string;
}

/** Options for cleaning up. */
export interface CleanupTmpOptions {
  keep: boolean;
}

/**
 * Create a fresh tmp workspace directory for staging a session.
 * Path shape: `<root>/<sessionId>-<rand>`. The directory exists on return.
 */
export async function makeTmpWorkspace(opts: MakeTmpOptions): Promise<string> {
  const suffix = randomBytes(4).toString("hex");
  const dir = path.join(opts.root, `${opts.sessionId}-${suffix}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Remove a tmp workspace. When `keep=true`, this is a no-op.
 * Safe to call on already-deleted directories.
 */
export async function cleanupTmpWorkspace(
  tmpDir: string,
  opts: CleanupTmpOptions
): Promise<void> {
  if (opts.keep) return;
  await rm(tmpDir, { recursive: true, force: true });
}
