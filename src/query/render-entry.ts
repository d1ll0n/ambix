// src/query/render-entry.ts
//
// Type-aware rendering of a single session log entry for `ambix query <ix>`.
// The default output strips CC's JSON envelope (parentUuid, promptId, usage,
// toolUseResult sidecar, etc.) and the per-field \n escaping. Agents that
// rehydrate a compaction stub get back content they can read — and grep —
// rather than a nested JSON blob whose inner text has literal \n escapes.
//
// Unknown / structural entry types fall back to pretty-JSON.

import type { LogEntry } from "parse-cc";
import {
  isAssistantEntry,
  isTextBlock,
  isToolResultBlock,
  isToolUseBlock,
  isUserEntry,
  parsePersistedOutput,
} from "parse-cc";

/**
 * Render an entry as readable text. Dispatches on entry type.
 */
export function renderEntry(entry: LogEntry): string {
  if (isAssistantEntry(entry)) return renderAssistant(entry);
  if (isUserEntry(entry)) return renderUser(entry);
  return renderJsonFallback(entry);
}

function renderAssistant(entry: Extract<LogEntry, { type: "assistant" }>): string {
  const parts: string[] = [];
  const header = `[assistant · ${entry.message.model}]`;
  parts.push(header);
  for (const block of entry.message.content) {
    if (isTextBlock(block)) {
      if (typeof block.text === "string") parts.push(block.text);
    } else if (isToolUseBlock(block)) {
      parts.push(`[tool_use: ${block.name} id=${block.id}]`);
      parts.push(`input: ${JSON.stringify(block.input, null, 2)}`);
    } else {
      // thinking / image / unknown — fall through to a compact JSON form
      parts.push(
        `[${(block as { type?: string }).type ?? "unknown-block"}] ${JSON.stringify(block)}`
      );
    }
  }
  return parts.join("\n");
}

function renderUser(entry: Extract<LogEntry, { type: "user" }>): string {
  const parts: string[] = [];
  const content = entry.message.content;
  if (typeof content === "string") {
    parts.push("[user]");
    parts.push(content);
    return parts.join("\n");
  }
  if (!Array.isArray(content)) return renderJsonFallback(entry);

  // Classify the entry by its first meaningful block.
  const hasToolResult = content.some((b) => isToolResultBlock(b as never));
  parts.push(hasToolResult ? "[user · tool_result]" : "[user]");

  for (const block of content) {
    if (isToolResultBlock(block)) {
      parts.push(`tool_use_id: ${block.tool_use_id}`);
      if (block.is_error) parts.push("is_error: true");
      parts.push("content:");
      parts.push(flattenToolResultContent(block.content));
    } else if (isTextBlock(block)) {
      if (typeof block.text === "string") parts.push(block.text);
    } else {
      parts.push(
        `[${(block as { type?: string }).type ?? "unknown-block"}] ${JSON.stringify(block)}`
      );
    }
  }
  return parts.join("\n");
}

function flattenToolResultContent(content: unknown): string {
  // `<persisted-output>` envelope — CC spilled the real content to a file.
  // Surface the file path, size, and preview so the caller can Read the
  // spill file for the full body instead of seeing the wrapper syntax.
  const spill = parsePersistedOutput(content);
  if (spill) {
    return [
      `[spilled to ${spill.filePath} — ${spill.sizeLabel}]`,
      "(Read the file above for full content; preview follows)",
      "",
      spill.preview,
    ].join("\n");
  }
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const out: string[] = [];
    for (const c of content) {
      if (c && typeof c === "object") {
        const rec = c as { type?: string; text?: unknown; content?: unknown };
        if (rec.type === "text" && typeof rec.text === "string") {
          out.push(rec.text);
          continue;
        }
        if (typeof rec.content === "string") {
          out.push(rec.content);
          continue;
        }
      }
      out.push(JSON.stringify(c));
    }
    return out.join("\n");
  }
  return content === null || content === undefined ? "" : JSON.stringify(content, null, 2);
}

function renderJsonFallback(entry: unknown): string {
  return JSON.stringify(entry, null, 2);
}
