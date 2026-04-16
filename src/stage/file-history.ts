// src/stage/file-history.ts
import { access, copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LogEntry, Session } from "parse-cc";
import { isFileHistorySnapshotEntry } from "parse-cc";
import type { SnapshotsIndex } from "../types.js";

/**
 * Build the staged file-history layout for a session.
 *
 * - Walks the session's file-history-snapshot entries
 * - Records the first ix at which each (path, version) pair was observed
 * - Copies the corresponding blobs from baseDir into <destDir>/blobs/
 * - Writes the snapshots.json index
 *
 * Does nothing (and creates no files) if the session has no file-history
 * snapshot entries. Blobs whose source file is missing are recorded in
 * the index with `blob: null`.
 */
export async function stageFileHistory(
  session: Session,
  destDir: string,
  baseDir: string
): Promise<void> {
  const messages = await session.messages();
  const records = collectSnapshotRecords(messages);
  if (records.size === 0) return;

  await mkdir(path.join(destDir, "blobs"), { recursive: true });

  const sessionFhDir = path.join(baseDir, session.sessionId);
  const idx: SnapshotsIndex = { files: [] };

  // Group by file path
  const byPath = new Map<
    string,
    Array<{ version: number; ix: number; backupTime: string; backupFileName: string | null }>
  >();
  for (const r of records.values()) {
    if (!byPath.has(r.path)) byPath.set(r.path, []);
    byPath.get(r.path)!.push(r);
  }

  for (const [filePath, versions] of byPath) {
    versions.sort((a, b) => a.version - b.version);
    const out: SnapshotsIndex["files"][number] = { path: filePath, versions: [] };
    for (const v of versions) {
      let blobRel: string | null = null;
      const bytes: number | null = null;
      if (v.backupFileName) {
        const blobSrc = path.join(sessionFhDir, v.backupFileName);
        try {
          await access(blobSrc);
          await copyFile(blobSrc, path.join(destDir, "blobs", v.backupFileName));
          blobRel = `blobs/${v.backupFileName}`;
          // size is best-effort; skip if not needed for ergonomics
        } catch {
          // missing blob — keep entry but with blob: null
        }
      }
      out.versions.push({
        version: v.version,
        ix: v.ix,
        backup_time: v.backupTime,
        blob: blobRel,
        bytes,
      });
    }
    idx.files.push(out);
  }

  idx.files.sort((a, b) => a.path.localeCompare(b.path));
  await writeFile(path.join(destDir, "snapshots.json"), JSON.stringify(idx, null, 2), "utf8");
}

interface SnapshotRecord {
  path: string;
  version: number;
  ix: number;
  backupTime: string;
  backupFileName: string | null;
}

function collectSnapshotRecords(messages: ReadonlyArray<LogEntry>): Map<string, SnapshotRecord> {
  // Key: "<path>@v<version>" — keep the FIRST ix we observed it at
  const map = new Map<string, SnapshotRecord>();
  for (let ix = 0; ix < messages.length; ix++) {
    const entry = messages[ix];
    if (!isFileHistorySnapshotEntry(entry)) continue;
    const backups = entry.snapshot.trackedFileBackups ?? {};
    for (const [filePath, info] of Object.entries(backups)) {
      const key = `${filePath}@v${info.version}`;
      if (map.has(key)) continue;
      map.set(key, {
        path: filePath,
        version: info.version,
        ix,
        backupTime: info.backupTime,
        backupFileName: info.backupFileName,
      });
    }
  }
  return map;
}
