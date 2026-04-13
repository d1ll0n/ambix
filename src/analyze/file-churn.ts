// src/analyze/file-churn.ts
import type { LogEntry } from "parse-claude-logs";
import { isAssistantEntry, isToolUseBlock } from "parse-claude-logs";
import type { ChurnRecord } from "./types.js";

/**
 * Build a per-file ordered event list of Read/Edit/Write activity.
 *
 * Preserves insertion order of the ix values so downstream consumers
 * can see the interleaving pattern (e.g. read → edit → read → edit).
 *
 * Returns an empty array when no file-affecting tools were used.
 */
export function buildFileChurnTimeline(entries: ReadonlyArray<LogEntry>): ChurnRecord[] {
  const map = new Map<string, ChurnRecord>();

  for (let ix = 0; ix < entries.length; ix++) {
    const entry = entries[ix];
    if (!isAssistantEntry(entry)) continue;
    for (const block of entry.message.content) {
      if (!isToolUseBlock(block)) continue;

      const kind = classifyTool(block.name);
      if (!kind) continue;

      const input = block.input;
      if (input === null || typeof input !== "object") continue;
      const fp = (input as { file_path?: unknown }).file_path;
      if (typeof fp !== "string") continue;

      if (!map.has(fp)) {
        map.set(fp, { path: fp, events: [] });
      }
      map.get(fp)!.events.push({ ix, kind });
    }
  }

  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function classifyTool(name: string): "read" | "edit" | "write" | null {
  switch (name) {
    case "Read":
      return "read";
    case "Write":
      return "write";
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    default:
      return null;
  }
}
