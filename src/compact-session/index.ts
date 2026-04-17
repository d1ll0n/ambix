// src/compact-session/index.ts
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type Session, defaultTasksDir } from "parse-cc";
import { emit } from "./emit.js";
import { copyTasksDir } from "./tasks.js";
import type { CompactSessionOptions, CompactSessionResult } from "./types.js";

const DEFAULT_FULL_RECENT = 10;
/** Cap on UUID re-rolls when one collides with an existing file/dir. */
const UUID_ROLL_MAX_ATTEMPTS = 8;

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

  const cwd = session.cwd ?? "";
  const gitBranch = session.gitBranch ?? "";
  const version = session.version ?? "";

  // Pick a UUID whose default JSONL path AND tasks dir are both free. Collisions
  // are astronomically unlikely, but if they happen we'd rather re-roll than
  // stomp real state. A fixed `--output` overrides only the JSONL path; the
  // tasks dir is still derived from the session UUID.
  const tasksBase = opts.tasksBaseDir ?? defaultTasksDir();
  const { newSessionId, destPath } = await pickFreshSessionId({
    cwd,
    output: opts.output,
    tasksBase,
  });

  const { entries: emitted, stats } = emit({
    sourceEntries: entries,
    newSessionId,
    origSessionId: session.sessionId,
    fullRecent,
    cwd,
    gitBranch,
    version,
    maxFieldBytes: opts.maxFieldBytes,
    previewChars: opts.previewChars,
  });

  let copiedTasksDir: string | null = null;
  if (!opts.dryRun) {
    await mkdir(path.dirname(destPath), { recursive: true });
    const jsonl = `${emitted.map((e) => JSON.stringify(e)).join("\n")}\n`;
    await writeFile(destPath, jsonl, "utf8");

    // Snapshot the source's tasks dir so the compacted session starts
    // with the same task state. Copy (not symlink) so the source can be
    // continued/forked independently without state entanglement.
    const copyResult = await copyTasksDir({
      origSessionId: session.sessionId,
      newSessionId,
      tasksBaseDir: opts.tasksBaseDir,
    });
    copiedTasksDir = copyResult.copiedTo;
  }

  return {
    newSessionId,
    destPath,
    dryRun: opts.dryRun ?? false,
    copiedTasksDir,
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

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Roll a fresh session UUID until both its derived JSONL destination and its
 * tasks dir are unoccupied. Throws after `UUID_ROLL_MAX_ATTEMPTS` rolls — if
 * we ever hit that, something systemic is wrong (not UUID collision).
 */
async function pickFreshSessionId(args: {
  cwd: string;
  output: string | undefined;
  tasksBase: string;
}): Promise<{ newSessionId: string; destPath: string }> {
  for (let attempt = 0; attempt < UUID_ROLL_MAX_ATTEMPTS; attempt++) {
    const newSessionId = randomUUID();
    const destPath = args.output ?? defaultDestPath(args.cwd, newSessionId);
    const tasksDir = path.join(args.tasksBase, newSessionId);
    const [destTaken, tasksTaken] = await Promise.all([exists(destPath), exists(tasksDir)]);
    if (!destTaken && !tasksTaken) {
      return { newSessionId, destPath };
    }
    // An --output that always points at the same path will always be taken —
    // re-rolling the UUID won't help. Surface that clearly.
    if (args.output && destTaken) {
      throw new Error(`compactSession: --output path already exists: ${destPath}`);
    }
  }
  throw new Error(
    `compactSession: could not pick a free session UUID in ${UUID_ROLL_MAX_ATTEMPTS} attempts`
  );
}

export type { CompactSessionOptions, CompactSessionResult, CompactSessionStats } from "./types.js";
