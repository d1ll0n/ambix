// src/analyze/subagents.ts
import type { LogEntry, Session } from "parse-claude-logs";
import { isAssistantEntry, isToolUseBlock } from "parse-claude-logs";
import type { SubagentRecord } from "./types.js";

/**
 * Cross-reference each subagent session with the parent's Task tool_use
 * block that most likely launched it.
 *
 * Linkage heuristic (v1):
 *   1. Collect every Task tool_use in the parent, in ix order, capturing
 *      subagent_type.
 *   2. Collect every subagent session, sorted by first-entry timestamp.
 *   3. Match by ordinal. Record `parent_ix: null` for any subagent
 *      beyond the number of Task tool_uses.
 */
export async function crossReferenceSubagents(session: Session): Promise<SubagentRecord[]> {
  const parentEntries = await session.messages();
  const subs = await session.subagents();
  if (subs.length === 0) return [];

  const taskCalls = collectTaskCalls(parentEntries);

  const subsWithMeta = await Promise.all(
    subs.map(async (sub) => {
      const entries = await sub.messages();
      const firstTs = firstTimestamp(entries);
      return { sub, entries, firstTs };
    })
  );
  subsWithMeta.sort((a, b) => {
    if (a.firstTs === null && b.firstTs === null) return 0;
    if (a.firstTs === null) return 1;
    if (b.firstTs === null) return -1;
    return a.firstTs.localeCompare(b.firstTs);
  });

  const out: SubagentRecord[] = [];
  for (let i = 0; i < subsWithMeta.length; i++) {
    const { sub, entries } = subsWithMeta[i];
    const match = i < taskCalls.length ? taskCalls[i] : null;
    const tokens = sumSubagentTokens(entries);
    out.push({
      agent_id: sub.sessionId,
      parent_ix: match ? match.ix : null,
      subagent_type: match ? match.subagent_type : null,
      turn_count: entries.length,
      tokens,
    });
  }
  return out;
}

interface TaskCall {
  ix: number;
  subagent_type: string | null;
}

function collectTaskCalls(entries: ReadonlyArray<LogEntry>): TaskCall[] {
  const out: TaskCall[] = [];
  for (let ix = 0; ix < entries.length; ix++) {
    const entry = entries[ix];
    if (!isAssistantEntry(entry)) continue;
    for (const block of entry.message.content) {
      if (!isToolUseBlock(block)) continue;
      if (block.name !== "Task") continue;
      const input = block.input as { subagent_type?: unknown } | null;
      const subagent_type =
        input && typeof input === "object" && typeof input.subagent_type === "string"
          ? input.subagent_type
          : null;
      out.push({ ix, subagent_type });
    }
  }
  return out;
}

function firstTimestamp(entries: ReadonlyArray<LogEntry>): string | null {
  for (const e of entries) {
    const ts = (e as { timestamp?: unknown }).timestamp;
    if (typeof ts === "string") return ts;
  }
  return null;
}

function sumSubagentTokens(entries: ReadonlyArray<LogEntry>): { in: number; out: number } {
  let inTok = 0;
  let outTok = 0;
  for (const entry of entries) {
    if (!isAssistantEntry(entry)) continue;
    if (entry.message.model === "<synthetic>") continue;
    inTok += entry.message.usage.input_tokens;
    outTok += entry.message.usage.output_tokens;
  }
  return { in: inTok, out: outTok };
}
