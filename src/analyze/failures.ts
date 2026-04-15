// src/analyze/failures.ts
import type { ContentBlock, LogEntry } from "parse-claude-logs";
import {
  isAssistantEntry,
  isToolResultBlock,
  isToolUseBlock,
  isUserEntry,
} from "parse-claude-logs";
import type { FailureRecord } from "./types.js";

/**
 * Collect every `is_error: true` tool_result, pairing it with the
 * preceding tool_use it corresponds to (matched by tool_use_id).
 *
 * The ix recorded on each record is the ix of the tool_result entry,
 * since that's where the error was observed in the conversation.
 *
 * The `input` field preserves the tool_use input verbatim (no
 * truncation) — the spec explicitly requires this.
 */
export function collectFailures(entries: ReadonlyArray<LogEntry>): FailureRecord[] {
  const toolUseMap = new Map<string, { name: string; input: unknown }>();
  for (const entry of entries) {
    if (!isAssistantEntry(entry)) continue;
    for (const block of entry.message.content) {
      if (!isToolUseBlock(block)) continue;
      toolUseMap.set(block.id, { name: block.name, input: block.input });
    }
  }

  const failures: FailureRecord[] = [];
  for (let ix = 0; ix < entries.length; ix++) {
    const entry = entries[ix];
    if (!isUserEntry(entry)) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isToolResultBlock(block)) continue;
      const errFlag = (block as { is_error?: unknown }).is_error;
      if (errFlag !== true) continue;

      const matched = toolUseMap.get(block.tool_use_id);
      failures.push({
        ix,
        tool: matched?.name ?? "unknown",
        tool_use_id: block.tool_use_id,
        input: matched?.input ?? null,
        error: stringifyErrorContent(block.content),
      });
    }
  }
  return failures;
}

function stringifyErrorContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const b of content as ContentBlock[]) {
      const anyB = b as unknown as Record<string, unknown>;
      if (anyB.type === "text" && typeof anyB.text === "string") {
        texts.push(anyB.text);
      }
    }
    return texts.join("\n");
  }
  return JSON.stringify(content);
}
