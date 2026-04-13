// src/stage/index.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Session } from "parse-claude-logs";
import { defaultFileHistoryDir } from "parse-claude-logs";
import type { StageLayout } from "../types.js";
import { buildMetadata } from "./metadata.js";
import { condenseEntries } from "./condense.js";
import { writeFullTurns } from "./turns.js";
import { collectAndCopySpills } from "./copy-spills.js";
import { stageFileHistory } from "./file-history.js";
import { stageSubagents } from "./copy-subagents.js";

/** Options for the top-level stage() call. */
export interface StageOptions {
  /** Inline content larger than this becomes a truncation stub. Default 2048. */
  maxInlineBytes?: number;
  /** Override the file-history base dir for tests. Defaults to ~/.claude/file-history. */
  fileHistoryBaseDir?: string;
}

/**
 * Top-level staging composition. Builds the entire tmp directory layout
 * for a session: metadata, condensed log, full turns for truncated
 * entries, copied spill files, file-history index, staged subagents.
 *
 * Returns a `StageLayout` describing what was produced.
 */
export async function stage(
  session: Session,
  tmpDir: string,
  opts: StageOptions = {}
): Promise<StageLayout> {
  const maxInlineBytes = opts.maxInlineBytes ?? 2048;
  await mkdir(tmpDir, { recursive: true });

  // 1. Metadata
  const metadata = await buildMetadata(session);
  const metadataPath = path.join(tmpDir, "metadata.json");
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");

  // 2. Condense
  const entries = await session.messages();
  const condensed = condenseEntries(entries, { maxInlineBytes });
  const sessionPath = path.join(tmpDir, "session.jsonl");
  const jsonl = condensed.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(sessionPath, jsonl, "utf8");

  // 3. Per-turn full files for truncated entries
  const truncatedIndices = condensed
    .filter((e) => containsTruncationStub(e.content))
    .map((e) => e.ix);
  const turnsDir = path.join(tmpDir, "turns");
  await writeFullTurns(turnsDir, entries, truncatedIndices);

  // 4. Spill files
  const spillDir = path.join(tmpDir, "spill");
  const spillResult = await collectAndCopySpills(entries, spillDir);

  // 5. File history
  const fileHistoryDir = path.join(tmpDir, "file-history");
  await stageFileHistory(
    session,
    fileHistoryDir,
    opts.fileHistoryBaseDir ?? defaultFileHistoryDir()
  );

  // 6. Subagents
  const subagentsDir = path.join(tmpDir, "subagents");
  const subResult = await stageSubagents(session, subagentsDir);

  return {
    tmpDir,
    metadataPath,
    sessionPath,
    turnsDir,
    spillDir,
    subagentsDir,
    fileHistoryDir,
    truncatedIndices,
    spillCount: spillResult.copied,
    subagentCount: subResult.staged,
  };
}

function containsTruncationStub(value: unknown): boolean {
  if (value === null || typeof value !== "object") return false;
  if ((value as { truncated?: boolean }).truncated === true) return true;
  if (Array.isArray(value)) {
    for (const item of value) {
      if (containsTruncationStub(item)) return true;
      if (item && typeof item === "object") {
        const v = item as Record<string, unknown>;
        if (v.input && typeof v.input === "object" && (v.input as { _truncated?: boolean })._truncated) return true;
        if (v.result && containsTruncationStub(v.result)) return true;
      }
    }
  }
  return false;
}
