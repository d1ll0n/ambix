// src/stage/turns.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Write per-turn full JSON files for the indices listed in `truncatedIndices`.
 *
 * Files are named with 5-digit zero padding (e.g. `00042.json`). The
 * destination directory is created if it does not exist. Untruncated
 * entries are skipped — only the entries whose indices appear in
 * `truncatedIndices` are written, since the condensed log already has
 * the rest inline.
 */
export async function writeFullTurns(
  destDir: string,
  entries: ReadonlyArray<unknown>,
  truncatedIndices: ReadonlyArray<number>
): Promise<void> {
  if (truncatedIndices.length === 0) return;
  await mkdir(destDir, { recursive: true });
  for (const ix of truncatedIndices) {
    const fileName = `${String(ix).padStart(5, "0")}.json`;
    const fullPath = path.join(destDir, fileName);
    await writeFile(fullPath, JSON.stringify(entries[ix], null, 2), "utf8");
  }
}
