// src/stage/copy-spills.ts
import { mkdir, copyFile, access } from "node:fs/promises";
import path from "node:path";
import type { LogEntry } from "parse-claude-logs";
import {
  isUserEntry,
  isToolResultBlock,
  parsePersistedOutput,
} from "parse-claude-logs";

/** Result of a spill-copy pass. */
export interface CopySpillsResult {
  copied: number;
  missing: number;
}

/**
 * Walk the entries, find every `<persisted-output>` reference inside
 * tool_result blocks, and copy each referenced file into `destDir`.
 *
 * The destination directory is created on first hit; if there are no
 * spills the directory is not created. Missing source files are
 * silently counted in `result.missing` rather than raising.
 */
export async function collectAndCopySpills(
  entries: ReadonlyArray<LogEntry>,
  destDir: string
): Promise<CopySpillsResult> {
  const sources = collectSpillSources(entries);
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

function collectSpillSources(entries: ReadonlyArray<LogEntry>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (!isUserEntry(entry)) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isToolResultBlock(block)) continue;
      if (typeof block.content !== "string") continue;
      const ref = parsePersistedOutput(block.content);
      if (!ref) continue;
      if (seen.has(ref.filePath)) continue;
      seen.add(ref.filePath);
      out.push(ref.filePath);
    }
  }
  return out;
}
