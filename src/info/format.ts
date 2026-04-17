// src/info/format.ts
import type { SessionInfo } from "./index.js";

/**
 * Render a SessionInfo as a human-readable text block. Intentionally
 * dense and aligned for quick scanning — not meant to be parsed.
 */
export function formatSessionInfo(info: SessionInfo): string {
  const { metadata: m, tokens: t } = info;

  const lines: string[] = [];
  const row = (label: string, value: string) => lines.push(`${label.padEnd(11)} ${value}`);

  row("session:", m.session_id);
  if (m.version) row("version:", m.version);
  if (m.cwd) row("cwd:", m.cwd);
  if (m.git_branch) row("branch:", m.git_branch);
  if (m.permission_mode) row("permission:", m.permission_mode);
  row("turns:", `${m.turn_count} (${m.end_state})`);
  if (m.duration_s != null) row("duration:", formatDuration(m.duration_s));
  if (m.start_ts) row("started:", m.start_ts);
  if (m.end_ts) row("ended:", m.end_ts);

  lines.push("");
  lines.push("tokens:");

  const modelEntries = Object.entries(t.by_model);
  const labelWidth = Math.max(
    "totals".length,
    ...modelEntries.map(([name, mt]) => `${name} (${mt.message_count} msgs)`.length)
  );

  lines.push(`  ${"totals".padEnd(labelWidth)}  ${formatTokens(t.totals)}`);
  for (const [name, mt] of modelEntries) {
    const label = `${name} (${mt.message_count} msgs)`.padEnd(labelWidth);
    lines.push(`  ${label}  ${formatTokens(mt)}`);
  }

  return `${lines.join("\n")}\n`;
}

function formatTokens(t: {
  in: number;
  out: number;
  cache_read: number;
  cache_write: number;
}): string {
  return `in=${t.in}  out=${t.out}  cache_read=${t.cache_read}  cache_write=${t.cache_write}`;
}

function formatDuration(seconds: number): string {
  if (seconds < 0) return `${seconds}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
