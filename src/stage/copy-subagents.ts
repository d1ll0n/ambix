// src/stage/copy-subagents.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Session } from "parse-claude-logs";
import { condenseEntries } from "./condense.js";
import { writeFullTurns } from "./turns.js";

/** Result of a subagent staging pass. */
export interface StageSubagentsResult {
  staged: number;
}

/**
 * Stage every subagent of `session` into `destDir/<agent-name>/`.
 *
 * Each subagent gets its own condensed `session.jsonl` and `turns/`
 * directory (for any truncated entries). Returns the number of
 * subagents staged. Does not recurse beyond one level — Claude Code
 * does not support nested subagents.
 *
 * NOTE: subagent tool spill files land in the PARENT session's shared
 * spill directory, not under the subagent. Spill copying happens at
 * the top-level stage() call, not here.
 */
export async function stageSubagents(
  session: Session,
  destDir: string
): Promise<StageSubagentsResult> {
  const subs = await session.subagents();
  if (subs.length === 0) return { staged: 0 };

  await mkdir(destDir, { recursive: true });

  let staged = 0;
  for (const sub of subs) {
    const subEntries = await sub.messages();
    if (subEntries.length === 0) continue;

    const subName = path.basename(sub.path, ".jsonl");
    const subDir = path.join(destDir, subName);
    await mkdir(subDir, { recursive: true });

    const condensed = condenseEntries(subEntries, { maxInlineBytes: 2048 });
    const truncated = findTruncatedIndices(condensed);

    const jsonl = condensed.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await writeFile(path.join(subDir, "session.jsonl"), jsonl, "utf8");

    if (truncated.length > 0) {
      await writeFullTurns(path.join(subDir, "turns"), subEntries, truncated);
    }

    staged++;
  }

  return { staged };
}

function findTruncatedIndices(condensed: ReadonlyArray<{ ix: number; content: unknown }>): number[] {
  const out: number[] = [];
  for (const e of condensed) {
    if (containsTruncationStub(e.content)) out.push(e.ix);
  }
  return out;
}

function containsTruncationStub(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if ((value as { truncated?: boolean }).truncated === true) return true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsTruncationStub(item)) return true;
    }
    return false;
  }
  // Arbitrary object: recurse into every field so nested stubs are detected.
  for (const v of Object.values(value as Record<string, unknown>)) {
    if (containsTruncationStub(v)) return true;
  }
  return false;
}
