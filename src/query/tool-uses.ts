// src/query/tool-uses.ts
import type { Session } from "parse-cc";
import { isAssistantEntry, isToolUseBlock } from "parse-cc";
import type { QueryMatch } from "./types.js";

/** Options for the tool-uses query. */
export interface ToolUsesOptions {
  /** Exact tool name match (e.g. "Write", "Read"). */
  name?: string;
}

/**
 * Walk a session's assistant entries and emit one QueryMatch per
 * tool_use block. Filters by tool name when provided.
 */
export async function queryToolUses(
  session: Session,
  opts: ToolUsesOptions
): Promise<QueryMatch[]> {
  const entries = await session.messages();
  const out: QueryMatch[] = [];
  for (let ix = 0; ix < entries.length; ix++) {
    const entry = entries[ix];
    if (!isAssistantEntry(entry)) continue;
    for (const block of entry.message.content) {
      if (!isToolUseBlock(block)) continue;
      if (opts.name && block.name !== opts.name) continue;
      out.push({
        ix,
        kind: "tool_use",
        summary: summarizeToolUse(block.name, block.input),
        raw: { id: block.id, name: block.name, input: block.input },
      });
    }
  }
  return out;
}

function summarizeToolUse(name: string, input: unknown): string {
  if (input === null || typeof input !== "object") return name;
  const i = input as Record<string, unknown>;
  const parts: string[] = [name];
  if (typeof i.file_path === "string") parts.push(`file_path=${i.file_path}`);
  if (typeof i.command === "string") {
    const firstLine = i.command.split("\n")[0].slice(0, 80);
    parts.push(`cmd=${firstLine}`);
  }
  if (typeof i.pattern === "string") parts.push(`pattern=${i.pattern}`);
  if (typeof i.subagent_type === "string") parts.push(`subagent_type=${i.subagent_type}`);
  return parts.join("  ");
}
