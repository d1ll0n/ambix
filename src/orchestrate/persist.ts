// src/orchestrate/persist.ts
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { homedir } from "node:os";
import type { Artifact } from "../artifact/types.js";

/** Options for persistence. */
export interface PersistOptions {
  /** Root directory to write under. Default `~/.alembic`. */
  outputRoot?: string;
}

/**
 * Write an artifact to `<outputRoot>/sessions/<session-id>/artifact.json`.
 * Creates parent directories if they don't exist. Returns the absolute
 * path to the written file.
 */
export async function persistArtifact(
  artifact: Artifact,
  opts: PersistOptions = {}
): Promise<string> {
  const root = opts.outputRoot ?? path.join(homedir(), ".alembic");
  const destDir = path.join(root, "sessions", artifact.session_id);
  await mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, "artifact.json");
  await writeFile(destPath, JSON.stringify(artifact, null, 2), "utf8");
  return destPath;
}
