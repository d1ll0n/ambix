// src/stage/metadata.ts
import path from "node:path";
import type { Session } from "parse-claude-logs";
import type { MetadataJson } from "../types.js";

/**
 * Produce structural metadata for the staged tmp dir. Reads only what
 * Session already exposes — no reasoning, no aggregation, just the
 * minimal frame the distiller agent needs at the top of its briefing.
 */
export async function buildMetadata(session: Session): Promise<MetadataJson> {
  const messages = await session.messages(); // primes scalar getters
  const ongoing = await session.isOngoing();

  const firstTs = firstNonNullTimestamp(messages);
  const lastTs = lastNonNullTimestamp(messages);
  const duration = computeDurationSeconds(firstTs, lastTs);

  const subs = await session.subagents();
  const query_targets: Record<string, string> = {
    "session.jsonl": session.path,
  };
  for (const sub of subs) {
    const subName = path.basename(sub.path, ".jsonl");
    query_targets[`subagents/${subName}/session.jsonl`] = sub.path;
  }

  return {
    session_id: session.sessionId,
    source_path: session.path,
    version: session.version,
    cwd: session.cwd,
    git_branch: session.gitBranch,
    permission_mode: session.permissionMode,
    start_ts: firstTs,
    end_ts: lastTs,
    duration_s: duration,
    turn_count: messages.length,
    end_state: ongoing ? "ongoing" : "completed",
    query_targets,
  };
}

function firstNonNullTimestamp(messages: ReadonlyArray<unknown>): string | null {
  for (const e of messages) {
    const ts = (e as { timestamp?: unknown }).timestamp;
    if (typeof ts === "string") return ts;
  }
  return null;
}

function lastNonNullTimestamp(messages: ReadonlyArray<unknown>): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const ts = (messages[i] as { timestamp?: unknown }).timestamp;
    if (typeof ts === "string") return ts;
  }
  return null;
}

function computeDurationSeconds(start: string | null, end: string | null): number | null {
  if (!start || !end) return null;
  const s = Date.parse(start);
  const e = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(e)) return null;
  return Math.round((e - s) / 1000);
}
