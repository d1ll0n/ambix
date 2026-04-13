// src/stage/copy-spills.ts
import { mkdir, copyFile, access } from "node:fs/promises";
import path from "node:path";
import type { Session } from "parse-claude-logs";
import { parsePersistedOutput } from "parse-claude-logs";

/** Result of a spill-copy pass. */
export interface CopySpillsResult {
  copied: number;
  missing: number;
}

/**
 * Walk the session's tool_result blocks (parent + every subagent) for
 * `<persisted-output>` references and copy each referenced file into
 * `destDir`.
 *
 * Subagent traversal is load-bearing: Claude Code spills tool results
 * from INSIDE a subagent into the PARENT session's shared
 * `tool-results/` dir, and the refs only appear in the subagent's own
 * tool_result blocks. Without walking subagents here, any spill file
 * referenced solely by a subagent will not be copied into `spill/`
 * and the subagent's condensed log will carry refs to files that
 * don't exist.
 *
 * Uses parse-claude-logs' `Session.toolResults()` (which handles the
 * user-entry + tool_result extraction) and `Session.subagents()` for
 * traversal. Subagents cannot nest, so one level of recursion is
 * sufficient.
 *
 * The destination directory is created on first hit; if there are no
 * spills the directory is not created. Missing source files are
 * silently counted in `result.missing` rather than raising.
 */
export async function collectAndCopySpills(
  session: Session,
  destDir: string
): Promise<CopySpillsResult> {
  const sources = await collectSpillSources(session);
  if (sources.length === 0) return { copied: 0, missing: 0 };

  await mkdir(destDir, { recursive: true });

  let copied = 0;
  let missing = 0;
  for (const src of sources) {
    try {
      await access(src);
    } catch {
      missing++;
      continue;
    }
    const fileName = path.basename(src);
    await copyFile(src, path.join(destDir, fileName));
    copied++;
  }
  return { copied, missing };
}

async function collectSpillSources(session: Session): Promise<string[]> {
  const seen = new Set<string>();
  const out: string[] = [];

  const collectFrom = async (sess: Session): Promise<void> => {
    const results = await sess.toolResults();
    for (const result of results) {
      if (typeof result.content !== "string") continue;
      const ref = parsePersistedOutput(result.content);
      if (!ref) continue;
      if (seen.has(ref.filePath)) continue;
      seen.add(ref.filePath);
      out.push(ref.filePath);
    }
  };

  await collectFrom(session);
  const subs = await session.subagents();
  for (const sub of subs) {
    await collectFrom(sub);
  }

  return out;
}
