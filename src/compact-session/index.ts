// src/compact-session/index.ts
import { randomUUID } from "node:crypto";
import { access, mkdir, writeFile } from "node:fs/promises";
import { rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { type Session, defaultTasksDir } from "parse-cc";
import { emitBundled } from "./bundled.js";
import { emit } from "./emit.js";
import { copyTasksDir } from "./tasks.js";
import type { CompactMode, CompactSessionOptions, CompactSessionResult } from "./types.js";

const DEFAULT_FULL_RECENT = 10;
const DEFAULT_MODE: CompactMode = "bundled";
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
  const mode = opts.mode ?? DEFAULT_MODE;

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

  const { entries: emitted, stats } =
    mode === "bundled"
      ? emitBundled({
          sourceEntries: entries,
          newSessionId,
          origSessionId: session.sessionId,
          fullRecent,
          cwd,
          gitBranch,
          version,
          maxFieldBytes: opts.maxFieldBytes,
          previewChars: opts.previewChars,
        })
      : emit({
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
    copiedTasksDir = await writeCompactedSession({
      destPath,
      emitted,
      origSessionId: session.sessionId,
      newSessionId,
      tasksBaseDir: opts.tasksBaseDir,
    });
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
 * Write the JSONL + snapshot the tasks dir with atomic-ish semantics:
 *
 *   1. Write JSONL to `<destPath>.tmp` with `O_EXCL` (flag: "wx"). This
 *      closes the TOCTOU window that a plain existence-check + writeFile
 *      leaves open.
 *   2. Copy the source tasks dir into the new session's tasks slot.
 *   3. Only after (1) and (2) both succeed, rename `.tmp → destPath`.
 *
 * On any failure, remove the `.tmp` file and (if we got that far) the
 * tasks dir. We don't want a partially-written session to show up in CC's
 * `/resume` list.
 */
async function writeCompactedSession(args: {
  destPath: string;
  emitted: ReadonlyArray<Record<string, unknown>>;
  origSessionId: string;
  newSessionId: string;
  tasksBaseDir: string | undefined;
}): Promise<string | null> {
  const tmpPath = `${args.destPath}.tmp`;
  await mkdir(path.dirname(args.destPath), { recursive: true });

  const jsonl = `${args.emitted.map((e) => JSON.stringify(e)).join("\n")}\n`;
  // `flag: "wx"` = open for writing, fail if the path exists (O_EXCL).
  // Closes the race between the pickFreshSessionId check and this write.
  try {
    await writeFile(tmpPath, jsonl, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `compactSession: tmp path already exists (another run in flight?): ${tmpPath}`
      );
    }
    throw err;
  }

  let copiedTasksDir: string | null = null;
  try {
    const copyResult = await copyTasksDir({
      origSessionId: args.origSessionId,
      newSessionId: args.newSessionId,
      tasksBaseDir: args.tasksBaseDir,
    });
    copiedTasksDir = copyResult.copiedTo;

    // Promote the tmp file to its final name. `rename` on the same
    // filesystem is atomic on POSIX; this is the closest we get to an
    // all-or-nothing commit without a db.
    await rename(tmpPath, args.destPath);
  } catch (err) {
    // Roll back on failure — we don't want orphaned artifacts under
    // ~/.claude/projects or ~/.claude/tasks.
    await rm(tmpPath, { force: true }).catch(() => {});
    if (copiedTasksDir) {
      await rm(copiedTasksDir, { recursive: true, force: true }).catch(() => {});
    }
    throw err;
  }

  return copiedTasksDir;
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

export type {
  CompactMode,
  CompactSessionOptions,
  CompactSessionResult,
  CompactSessionStats,
} from "./types.js";
