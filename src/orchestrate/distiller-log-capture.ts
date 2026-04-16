// src/orchestrate/distiller-log-capture.ts
import { access, mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

/** Options for capturing a distiller run's session logs. */
export interface CaptureDistillerLogOptions {
  /** Absolute path to the staged tmp dir the distiller ran in. */
  tmpDir: string;
  /** Source session id — used to build the destination path. */
  sessionId: string;
  /** Output root (defaults to ~/.ambix). */
  outputRoot?: string;
  /** Override the Claude Code home (defaults to ~/.claude). Used by tests. */
  ccHome?: string;
  /** How often to poll the source dir for stability, in ms (default 300). */
  stabilityPollIntervalMs?: number;
  /** How long to wait for stability before proceeding anyway, in ms (default 5000). */
  stabilityTimeoutMs?: number;
}

/** Result of a capture pass. */
export interface CaptureDistillerLogResult {
  /** Number of top-level `.jsonl` files moved. */
  filesCaptured: number;
  /** Destination directory (may be empty string when nothing was captured). */
  destDir: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function walk(
  dir: string,
  out: Array<{ path: string; size: number }>,
  rel = ""
): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const n of names) {
    const abs = path.join(dir, n);
    const relPath = path.join(rel, n);
    try {
      const s = await stat(abs);
      if (s.isDirectory()) {
        await walk(abs, out, relPath);
      } else {
        out.push({ path: relPath, size: s.size });
      }
    } catch {
      // skip missing files
    }
  }
}

async function dirSignature(dir: string): Promise<string> {
  const entries: Array<{ path: string; size: number }> = [];
  await walk(dir, entries);
  entries.sort((a, b) => a.path.localeCompare(b.path));
  return entries.map((e) => `${e.path}:${e.size}`).join("|");
}

/**
 * Poll `dir` until two consecutive observations (separated by `pollIntervalMs`)
 * show identical (filename, size) sets, or until `timeoutMs` elapses.
 *
 * When the timeout fires the function resolves anyway — capture is best-effort.
 */
export async function waitForStability(
  dir: string,
  opts: { pollIntervalMs: number; timeoutMs: number; stableObservations: number } = {
    pollIntervalMs: 300,
    timeoutMs: 5000,
    stableObservations: 2,
  }
): Promise<void> {
  const { pollIntervalMs, timeoutMs, stableObservations } = opts;
  const deadline = Date.now() + timeoutMs;
  let lastSignature: string | null = null;
  let stableCount = 0;

  while (Date.now() < deadline) {
    const signature = await dirSignature(dir);
    if (signature === lastSignature) {
      stableCount++;
      if (stableCount >= stableObservations) return;
    } else {
      stableCount = 0;
      lastSignature = signature;
    }
    await sleep(pollIntervalMs);
  }
  // Timeout: proceed anyway, best-effort
}

/**
 * Move the distiller agent's own session log out of the normal Claude Code
 * projects directory so it doesn't feed back into future `ambix distill`
 * runs (and so we have the full distiller transcript saved alongside the
 * artifact for debugging).
 *
 * The distiller agent runs with `cwd=tmpDir`, and Claude Code writes its
 * session log to `<ccHome>/projects/<slug>/*.jsonl` where `slug` is
 * `tmpDir.replace(/\//g, "-")`. This function:
 *   1. Resolves the source project dir
 *   2. Waits for the source dir to stabilize (SDK keeps writing asynchronously)
 *   3. Creates `<outputRoot>/sessions/<sessionId>/distiller-log/`
 *   4. Moves everything inside the source project dir into the destination
 *   5. Removes the now-empty source dir
 *
 * No-ops cleanly if the source dir doesn't exist (e.g. a run failed before
 * the agent wrote anything).
 */
export async function captureDistillerLog(
  opts: CaptureDistillerLogOptions
): Promise<CaptureDistillerLogResult> {
  const ccHome = opts.ccHome ?? path.join(homedir(), ".claude");
  const outputRoot = opts.outputRoot ?? path.join(homedir(), ".ambix");

  const slug = opts.tmpDir.replace(/\//g, "-");
  const sourceProjectDir = path.join(ccHome, "projects", slug);

  try {
    await access(sourceProjectDir);
  } catch {
    return { filesCaptured: 0, destDir: "" };
  }

  await waitForStability(sourceProjectDir, {
    pollIntervalMs: opts.stabilityPollIntervalMs ?? 300,
    timeoutMs: opts.stabilityTimeoutMs ?? 5000,
    stableObservations: 2,
  });

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
