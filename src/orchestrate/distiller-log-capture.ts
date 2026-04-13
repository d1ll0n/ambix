// src/orchestrate/distiller-log-capture.ts
import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Options for capturing a distiller run's session logs. */
export interface CaptureDistillerLogOptions {
  /** Absolute path to the staged tmp dir the distiller ran in. */
  tmpDir: string;
  /** Source session id — used to build the destination path. */
  sessionId: string;
  /** Output root (defaults to ~/.alembic). */
  outputRoot?: string;
  /** Override the Claude Code home (defaults to ~/.claude). Used by tests. */
  ccHome?: string;
}

/** Result of a capture pass. */
export interface CaptureDistillerLogResult {
  /** Number of top-level `.jsonl` files moved. */
  filesCaptured: number;
  /** Destination directory (may be empty string when nothing was captured). */
  destDir: string;
}

/**
 * Move the distiller agent's own session log out of the normal Claude Code
 * projects directory so it doesn't feed back into future `alembic distill`
 * runs (and so we have the full distiller transcript saved alongside the
 * artifact for debugging).
 *
 * The distiller agent runs with `cwd=tmpDir`, and Claude Code writes its
 * session log to `<ccHome>/projects/<slug>/*.jsonl` where `slug` is
 * `tmpDir.replace(/\//g, "-")`. This function:
 *   1. Resolves the source project dir
 *   2. Creates `<outputRoot>/sessions/<sessionId>/distiller-log/`
 *   3. Moves everything inside the source project dir into the destination
 *   4. Removes the now-empty source dir
 *
 * No-ops cleanly if the source dir doesn't exist (e.g. a run failed before
 * the agent wrote anything).
 */
export async function captureDistillerLog(
  opts: CaptureDistillerLogOptions
): Promise<CaptureDistillerLogResult> {
  const ccHome = opts.ccHome ?? path.join(homedir(), ".claude");
  const outputRoot = opts.outputRoot ?? path.join(homedir(), ".alembic");

  const slug = opts.tmpDir.replace(/\//g, "-");
  const sourceProjectDir = path.join(ccHome, "projects", slug);

  try {
    await access(sourceProjectDir);
  } catch {
    return { filesCaptured: 0, destDir: "" };
  }

  const destDir = path.join(outputRoot, "sessions", opts.sessionId, "distiller-log");
  await mkdir(destDir, { recursive: true });

  let filesCaptured = 0;
  const entries = await readdir(sourceProjectDir, { withFileTypes: true });
  for (const entry of entries) {
    const src = path.join(sourceProjectDir, entry.name);
    const dest = path.join(destDir, entry.name);
    await rename(src, dest);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) filesCaptured++;
  }

  // Remove the now-empty source project dir (best-effort)
  try {
    await rm(sourceProjectDir, { recursive: true });
  } catch {
    // ignore
  }

  return { filesCaptured, destDir };
}
