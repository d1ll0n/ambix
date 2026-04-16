// src/analyze/spills.ts
import type { LogEntry } from "parse-cc";
import { isToolResultBlock, isUserEntry, parsePersistedOutput } from "parse-cc";
import type { SpillRecord } from "./types.js";

/**
 * Walk the entries and inventory every `<persisted-output>` reference
 * found inside tool_result blocks. The returned records carry
 * tool_use_id, owning ix (the tool_result entry's ix), source file
 * path, and the human-readable size label from the wrapper.
 */
export function inventorySpills(entries: ReadonlyArray<LogEntry>): SpillRecord[] {
  const out: SpillRecord[] = [];
  for (let ix = 0; ix < entries.length; ix++) {
    const entry = entries[ix];
    if (!isUserEntry(entry)) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isToolResultBlock(block)) continue;
      if (typeof block.content !== "string") continue;
      const ref = parsePersistedOutput(block.content);
      if (!ref) continue;
      out.push({
        tool_use_id: block.tool_use_id,
        owning_ix: ix,
        file_path: ref.filePath,
        size_label: ref.sizeLabel,
      });
    }
  }
  return out;
}
