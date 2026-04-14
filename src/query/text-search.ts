// src/query/text-search.ts
import type { Session, ContentBlock } from "parse-claude-logs";
import { isUserEntry, isAssistantEntry } from "parse-claude-logs";
import type { QueryMatch } from "./types.js";

/** Options for the text-search query. */
export interface TextSearchOptions {
  pattern: string;
  /** Restrict to user or assistant entries. Default: both. */
  role?: "user" | "assistant";
}

/**
 * Substring-search the text content of user and assistant entries.
 * Returns one QueryMatch per entry whose text contains the pattern.
 */
export async function queryTextSearch(
  session: Session,
  opts: TextSearchOptions
): Promise<QueryMatch[]> {
  const entries = await session.messages();
  const out: QueryMatch[] = [];
  const needle = opts.pattern;

  for (let ix = 0; ix < entries.length; ix++) {
    const entry = entries[ix];
    let role: "user" | "assistant" | null = null;
    let text = "";

    if (isUserEntry(entry)) {
      role = "user";
      text = extractUserText(entry.message.content);
    } else if (isAssistantEntry(entry)) {
      role = "assistant";
      text = extractAssistantText(entry.message.content);
    } else {
      continue;
    }

    if (opts.role && role !== opts.role) continue;
    if (!text.includes(needle)) continue;

    const snippet = extractSnippet(text, needle);
    out.push({
      ix,
      kind: role,
      summary: snippet,
    });
  }
  return out;
}

function extractUserText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content as ContentBlock[]) {
    const anyB = block as Record<string, unknown>;
    if (anyB.type === "text" && typeof anyB.text === "string") {
      parts.push(anyB.text as string);
    } else if (anyB.type === "tool_result") {
      const c = anyB.content;
      if (typeof c === "string") parts.push(c);
    }
  }
  return parts.join("\n");
}

function extractAssistantText(content: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of content) {
    const anyB = block as Record<string, unknown>;
    if (anyB.type === "text" && typeof anyB.text === "string") {
      parts.push(anyB.text as string);
    }
  }
  return parts.join("\n");
}

function extractSnippet(text: string, needle: string): string {
  const idx = text.indexOf(needle);
  if (idx < 0) return text.slice(0, 80);
  const start = Math.max(0, idx - 20);
  const end = Math.min(text.length, idx + needle.length + 60);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return (prefix + text.slice(start, end) + suffix).replace(/\n/g, " ");
}
