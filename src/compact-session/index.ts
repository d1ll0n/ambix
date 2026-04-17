// src/compact-session/index.ts
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Session } from "parse-cc";
import { emit } from "./emit.js";
import type { CompactSessionOptions, CompactSessionResult } from "./types.js";

const DEFAULT_FULL_RECENT = 10;

/**
 * Produce a compacted session JSONL from an existing Claude Code session.
 *
 * Output layout:
 *   [condensed entries — tool_result bodies replaced with rehydration stubs]
 *   [isCompactSummary divider]
 *   [preserved entries — the last `fullRecent` rounds passed through verbatim]
 *
 * The compacted session gets a fresh UUID. By default it's written into the
 * source's CC project slug (`~/.claude/projects/<slug>/<new-uuid>.jsonl`) so
 * it shows up in `/resume` when the user is in the source's cwd.
 *
 * Stubs reference the ORIGINAL session's turn index, so rehydration via
 * `ambix query <orig-session-id> <ix>` retrieves the pre-compaction content.
 */
export async function compactSession(
  session: Session,
  opts: CompactSessionOptions = {}
): Promise<CompactSessionResult> {
  const entries = await session.messages();
  const fullRecent = opts.fullRecent ?? DEFAULT_FULL_RECENT;
  const newSessionId = randomUUID();

  const cwd = session.cwd ?? "";
  const gitBranch = session.gitBranch ?? "";
  const version = session.version ?? "";

  const destPath = opts.output ?? defaultDestPath(cwd, newSessionId);

  const { entries: emitted, stats } = emit({
    sourceEntries: entries,
    newSessionId,
    origSessionId: session.sessionId,
    fullRecent,
    cwd,
    gitBranch,
    version,
  });

  if (!opts.dryRun) {
    await mkdir(path.dirname(destPath), { recursive: true });
    const jsonl = `${emitted.map((e) => JSON.stringify(e)).join("\n")}\n`;
    await writeFile(destPath, jsonl, "utf8");
  }

  return {
    newSessionId,
    destPath,
    dryRun: opts.dryRun ?? false,
    stats,
  };
}

/**
 * Default destination: same CC project slug as the source so the new session
 * appears in `/resume` for that cwd. CC derives the slug from a cwd by
 * replacing `/` with `-`.
 */
function defaultDestPath(cwd: string, newSessionId: string): string {
  if (!cwd) {
    throw new Error("compactSession: source session has no cwd — pass opts.output explicitly");
  }
  const slug = cwd.replaceAll("/", "-");
  return path.join(homedir(), ".claude", "projects", slug, `${newSessionId}.jsonl`);
}

export type { CompactSessionOptions, CompactSessionResult, CompactSessionStats } from "./types.js";
