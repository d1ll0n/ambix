// src/compact-session/preserve-tools.ts
//
// Tool names whose tool_use inputs and tool_result bodies MUST survive
// compaction verbatim, regardless of render mode.
//
// CC reconstructs its live task list at resume time by replaying Task*
// tool_uses + their matched tool_results from the session history. If we
// stub or prose-render these calls, the resumed session comes back with
// an empty task list. Payloads are tiny (~6 KB total per typical session)
// so pass-through has negligible cost.

export const PRESERVE_TOOLS: ReadonlySet<string> = new Set([
  "TaskCreate",
  "TaskUpdate",
  "TaskGet",
  "TaskList",
  "TaskOutput",
  "TaskStop",
]);

/** True if a tool name is on the preserve allowlist. */
export function shouldPreserveTool(name: string | undefined): boolean {
  return typeof name === "string" && PRESERVE_TOOLS.has(name);
}
