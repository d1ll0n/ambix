// src/analyze/permissions.ts
import type { LogEntry } from "parse-cc";
import { isAttachmentEntry, isPermissionModeEntry } from "parse-cc";
import type { PermissionEvent } from "./types.js";

const HOOK_ATTACHMENT_KINDS = new Set([
  "hook_additional_context",
  "hook_success",
  "hook_system_message",
  "command_permissions",
]);

/**
 * Collect permission-mode changes and hook-related attachment events
 * into a timeline ordered by ix.
 */
export function collectPermissionEvents(entries: ReadonlyArray<LogEntry>): PermissionEvent[] {
  const out: PermissionEvent[] = [];
  for (let ix = 0; ix < entries.length; ix++) {
    const entry = entries[ix];

    if (isPermissionModeEntry(entry)) {
      out.push({
        ix,
        kind: "permission_mode",
        details: { permissionMode: entry.permissionMode },
      });
      continue;
    }

    if (isAttachmentEntry(entry)) {
      const payload = entry.attachment as { type?: unknown };
      const kind = typeof payload.type === "string" ? payload.type : null;
      if (kind && HOOK_ATTACHMENT_KINDS.has(kind)) {
        out.push({ ix, kind, details: payload });
      }
    }
  }
  return out;
}
