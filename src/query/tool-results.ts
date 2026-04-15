// src/query/tool-results.ts
import type { ContentBlock, Session } from "parse-claude-logs";
import { isToolResultBlock, isUserEntry } from "parse-claude-logs";
import type { QueryMatch } from "./types.js";

/** Options for the tool-results query. */
export interface ToolResultsOptions {
  /** Only return results flagged is_error=true. */
  error?: boolean;
  /** Only return the tool_result for this specific tool_use_id. */
  toolUseId?: string;
}

/**
 * Walk a session's user entries and emit one QueryMatch per
 * tool_result block, applying the requested filters.
 */
export async function queryToolResults(
  session: Session,
  opts: ToolResultsOptions
): Promise<QueryMatch[]> {
  const entries = await session.messages();
  const out: QueryMatch[] = [];
  for (let ix = 0; ix < entries.length; ix++) {
    const entry = entries[ix];
    if (!isUserEntry(entry)) continue;
    const content = entry.message.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isToolResultBlock(block)) continue;
      const isError = (block as { is_error?: unknown }).is_error === true;
      if (opts.error && !isError) continue;
      if (opts.toolUseId && block.tool_use_id !== opts.toolUseId) continue;
      out.push({
        ix,
        kind: "tool_result",
        summary: summarizeToolResult(block.tool_use_id, block.content, isError),
        raw: { tool_use_id: block.tool_use_id, is_error: isError, content: block.content },
      });
    }
  }
  return out;
}

function summarizeToolResult(toolUseId: string, content: unknown, isError: boolean): string {
  const parts: string[] = [toolUseId];
  if (isError) parts.push("[ERROR]");
  const text = extractTextSnippet(content);
  if (text) parts.push(text.slice(0, 80));
  return parts.join("  ");
}

function extractTextSnippet(content: unknown): string {
  if (typeof content === "string") return content.replace(/\n/g, " ");
  if (!Array.isArray(content)) return "";
  for (const block of content as ContentBlock[]) {
    const anyB = block as unknown as Record<string, unknown>;
    if (anyB.type === "text" && typeof anyB.text === "string") {
      return (anyB.text as string).replace(/\n/g, " ");
    }
  }
  return "";
}
