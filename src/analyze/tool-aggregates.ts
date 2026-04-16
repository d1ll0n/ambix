// src/analyze/tool-aggregates.ts
import type { LogEntry } from "parse-cc";
import { isAssistantEntry, isToolUseBlock } from "parse-cc";
import type { FileRecord, FilesSummary, ToolsSummary } from "./types.js";

/** Output of tool-use aggregation. */
export interface ToolAggregatesResult {
  tools: ToolsSummary;
  files: FilesSummary;
}

/**
 * Walk all assistant entries, aggregating:
 *   - Per-tool invocation counts
 *   - Per-file Read/Edit/Write counts (for tools that carry `file_path`)
 *   - read_without_write: files read one or more times but never modified
 *
 * MultiEdit counts as a single edit on its `file_path`.
 *
 * Non-file tools (Bash, Grep, Glob, etc.) contribute to invocation
 * counts but not to the per-file view.
 */
export function aggregateToolUse(entries: ReadonlyArray<LogEntry>): ToolAggregatesResult {
  const invocations: Record<string, number> = {};
  const fileMap = new Map<string, FileRecord>();

  for (const entry of entries) {
    if (!isAssistantEntry(entry)) continue;
    for (const block of entry.message.content) {
      if (!isToolUseBlock(block)) continue;
      invocations[block.name] = (invocations[block.name] ?? 0) + 1;

      const filePath = extractFilePath(block.input);
      if (!filePath) continue;

      if (!fileMap.has(filePath)) {
        fileMap.set(filePath, { path: filePath, reads: 0, edits: 0, writes: 0 });
      }
      const rec = fileMap.get(filePath)!;
      switch (block.name) {
        case "Read":
          rec.reads += 1;
          break;
        case "Write":
          rec.writes += 1;
          break;
        case "Edit":
        case "MultiEdit":
        case "NotebookEdit":
          rec.edits += 1;
          break;
      }
    }
  }

  const touched = [...fileMap.values()].sort((a, b) => a.path.localeCompare(b.path));
  const read_without_write = touched
    .filter((f) => f.reads > 0 && f.edits === 0 && f.writes === 0)
    .map((f) => f.path);

  return {
    tools: { invocations },
    files: { touched, read_without_write },
  };
}

function extractFilePath(input: unknown): string | null {
  if (input === null || typeof input !== "object") return null;
  const fp = (input as { file_path?: unknown }).file_path;
  return typeof fp === "string" ? fp : null;
}
