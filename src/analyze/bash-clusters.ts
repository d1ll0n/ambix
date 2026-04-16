// src/analyze/bash-clusters.ts
import type { LogEntry } from "parse-cc";
import { isAssistantEntry, isToolUseBlock } from "parse-cc";
import type { BashCluster } from "./types.js";

const MAX_EXAMPLES = 5;

/**
 * Cluster Bash tool invocations by first whitespace-separated token.
 *
 * This is a v1 normalization — good enough to surface "git was used 12
 * times" without overclaiming that all `git` invocations are the same.
 */
export function clusterBashCommands(entries: ReadonlyArray<LogEntry>): BashCluster[] {
  const map = new Map<string, BashCluster>();

  for (let ix = 0; ix < entries.length; ix++) {
    const entry = entries[ix];
    if (!isAssistantEntry(entry)) continue;
    for (const block of entry.message.content) {
      if (!isToolUseBlock(block)) continue;
      if (block.name !== "Bash") continue;

      const input = block.input;
      if (input === null || typeof input !== "object") continue;
      const command = (input as { command?: unknown }).command;
      if (typeof command !== "string") continue;

      const token = firstToken(command);
      if (!token) continue;

      if (!map.has(token)) {
        map.set(token, { pattern: token, count: 0, examples_ix: [] });
      }
      const cluster = map.get(token)!;
      cluster.count += 1;
      if (cluster.examples_ix.length < MAX_EXAMPLES) {
        cluster.examples_ix.push(ix);
      }
    }
  }

  return [...map.values()].sort((a, b) => b.count - a.count);
}

function firstToken(command: string): string | null {
  const trimmed = command.trim();
  if (!trimmed) return null;
  const match = /^(\S+)/.exec(trimmed);
  return match ? match[1] : null;
}
