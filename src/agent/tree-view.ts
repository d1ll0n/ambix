// src/agent/tree-view.ts
import { readdir, stat, readFile } from "node:fs/promises";
import path from "node:path";

/** Produce a compact tree-style summary of a staged alembic tmp dir. */
export async function buildTreeView(tmpDir: string): Promise<string> {
  const lines: string[] = [];
  lines.push("```");
  lines.push(`${path.basename(tmpDir)}/`);

  const rootEntries = await safeReaddir(tmpDir);
  const presentRoot = new Set(rootEntries);

  // metadata.json
  if (presentRoot.has("metadata.json")) {
    lines.push("├── metadata.json");
  }

  // session.jsonl
  if (presentRoot.has("session.jsonl")) {
    const info = await sessionInfo(path.join(tmpDir, "session.jsonl"));
    lines.push(`├── session.jsonl                     ${info}`);
  }

  // turns/
  if (presentRoot.has("turns")) {
    const turnFiles = (await safeReaddir(path.join(tmpDir, "turns")))
      .filter((n) => n.endsWith(".json"))
      .sort();
    lines.push(
      `├── turns/                            (${turnFiles.length} files — full turns for truncated entries)`
    );
    for (const t of turnFiles.slice(0, 3)) {
      lines.push(`│   ├── ${t}`);
    }
    if (turnFiles.length > 3) {
      lines.push(`│   └── ... (${turnFiles.length - 3} more)`);
    }
  }

  // spill/
  if (presentRoot.has("spill")) {
    const spillFiles = (await safeReaddir(path.join(tmpDir, "spill"))).sort();
    lines.push(
      `├── spill/                            (${spillFiles.length} files — off-log tool results)`
    );
    for (const s of spillFiles.slice(0, 5)) {
      const size = await safeSizeLabel(path.join(tmpDir, "spill", s));
      lines.push(`│   ├── ${truncateMiddle(s, 40)}     ${size}`);
    }
    if (spillFiles.length > 5) {
      lines.push(`│   └── ... (${spillFiles.length - 5} more)`);
    }
  }

  // subagents/
  if (presentRoot.has("subagents")) {
    const subDirs = (await safeReaddir(path.join(tmpDir, "subagents"))).sort();
    lines.push(`├── subagents/                        (${subDirs.length} agents)`);
    const shownSubs = subDirs.slice(0, 5);
    for (const sd of shownSubs) {
      const subSession = path.join(tmpDir, "subagents", sd, "session.jsonl");
      const info = await sessionInfo(subSession);
      lines.push(`│   ├── ${truncateMiddle(sd, 28)}/session.jsonl  ${info}`);
    }
    if (subDirs.length > shownSubs.length) {
      lines.push(`│   └── ... (${subDirs.length - shownSubs.length} more)`);
    }
  }

  // file-history/
  if (presentRoot.has("file-history")) {
    lines.push("├── file-history/");
    const fhEntries = await safeReaddir(path.join(tmpDir, "file-history"));
    if (fhEntries.includes("snapshots.json")) {
      lines.push("│   ├── snapshots.json");
    }
    const blobs = await safeReaddir(path.join(tmpDir, "file-history", "blobs"));
    lines.push(
      `│   └── blobs/                        (${blobs.length} blobs — use bin/file-at to resolve)`
    );
  }

  // out/
  if (presentRoot.has("out")) {
    lines.push("├── out/                              (write narrative.json here)");
  }

  // bin/
  if (presentRoot.has("bin")) {
    const binEntries = (await safeReaddir(path.join(tmpDir, "bin"))).sort();
    lines.push("└── bin/");
    for (let i = 0; i < binEntries.length; i++) {
      const last = i === binEntries.length - 1;
      const prefix = last ? "    └──" : "    ├──";
      const note = binNote(binEntries[i]);
      lines.push(`${prefix} ${binEntries[i]}${note}`);
    }
  }

  lines.push("```");
  return lines.join("\n");
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}

async function safeSizeLabel(p: string): Promise<string> {
  try {
    const s = await stat(p);
    return `(${humanSize(s.size)})`;
  } catch {
    return "";
  }
}

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function sessionInfo(sessionPath: string): Promise<string> {
  try {
    const [s, text] = await Promise.all([stat(sessionPath), readFile(sessionPath, "utf8")]);
    const lineCount = text
      .split("\n")
      .filter((l) => l.trim().length > 0).length;
    return `(${humanSize(s.size)}, ${lineCount} turns)`;
  } catch {
    return "";
  }
}

function truncateMiddle(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const keep = maxLen - 3;
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + "..." + s.slice(s.length - tail);
}

function binNote(name: string): string {
  switch (name) {
    case "lint-output":
      return "    (validator — run before declaring done)";
    case "query":
      return "          (search session logs — see --help)";
    case "file-at":
      return "        (read a tracked file at a turn)";
    default:
      return "";
  }
}
