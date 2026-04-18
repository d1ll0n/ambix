// src/compact-session/emit-shared.ts
//
// Helpers shared by both the structural emitter (emit.ts) and the bundled
// emitter (bundled.ts):
//
//   - rewritePreservedEntry — produce an entry cloned from the source with
//     a fresh uuid / parentUuid / sessionId / routing IDs, but the payload
//     untouched. Used for the preserved tail in both modes, and for
//     Task* pass-through entries in bundled mode.
//   - regenerateRoutingIds — the low-level routing-ID rewrite, broken out
//     so emit.ts's condensed-path and this file agree on the rules.

import { randomUUID } from "node:crypto";
import type { LogEntry } from "parse-cc";

/**
 * Rewrite uuid chain + per-session identifiers on a source entry. The
 * payload (message.content, tool_use inputs, tool_result bodies, etc.) is
 * left alone — callers that want condensation should route through
 * structural-mode's `rewriteEntry` instead.
 *
 * Returns `hasUuid` so the caller can decide whether to advance its
 * parentUuid cursor (structural-only entries like file-history-snapshot
 * have no uuid to chain through).
 */
export function rewritePreservedEntry(opts: {
  source: LogEntry;
  newUuid: string;
  newSessionId: string;
  parentUuid: string | null;
  uuidFn?: () => string;
}): { entry: Record<string, unknown>; hasUuid: boolean } {
  const cloned = JSON.parse(JSON.stringify(opts.source)) as Record<string, unknown>;
  const hasUuid = "uuid" in cloned;
  if (hasUuid) cloned.uuid = opts.newUuid;
  if ("parentUuid" in cloned) cloned.parentUuid = opts.parentUuid;
  if ("sessionId" in cloned) cloned.sessionId = opts.newSessionId;

  // Regenerate cross-entry identifiers even when we're preserving the
  // payload — otherwise the compacted entries still carry the source
  // session's requestId / promptId / message.id, and CC's resume logic
  // treats them as duplicates of the source.
  regenerateRoutingIds(cloned, opts.uuidFn ?? randomUUID);

  return { entry: cloned, hasUuid };
}

export function regenerateRoutingIds(cloned: Record<string, unknown>, uuidFn: () => string): void {
  if (typeof cloned.promptId === "string") cloned.promptId = uuidFn();
  if (typeof cloned.requestId === "string") {
    cloned.requestId = `req_${uuidFn().replaceAll("-", "").slice(0, 22)}`;
  }
  const msg = cloned.message;
  if (msg && typeof msg === "object") {
    const m = msg as Record<string, unknown>;
    if (typeof m.id === "string") {
      m.id = `msg_${uuidFn().replaceAll("-", "").slice(0, 22)}`;
    }
  }
}
