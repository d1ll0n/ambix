// src/stage/format-stats.ts
import type { CondenseStats, CondenseStatsRow } from "./condense.js";

/**
 * Format a CondenseStats report as a human-readable table, sorted by
 * original byte size descending. Columns: kind, count, orig KB,
 * inlined KB, truncated (count/total).
 *
 * Returns a multi-line string with a trailing newline.
 */
export function formatCondenseStats(stats: CondenseStats, opts: { title?: string } = {}): string {
  const title = opts.title ?? "Condensation report";
  const rows = stats.rows;

  const headers = ["Kind", "count", "orig KB", "inlined KB", "truncated"];
  const formatted: string[][] = rows.map((r) => [
    r.kind,
    String(r.count),
    formatKb(r.origBytes),
    formatKb(r.inlinedBytes),
    formatTruncated(r),
  ]);
  const totalsRow = [
    "TOTAL",
    String(stats.totals.count),
    formatKb(stats.totals.origBytes),
    formatKb(stats.totals.inlinedBytes),
    `${stats.totals.truncatedCount}/${stats.totals.count}`,
  ];

  const widths = headers.map((h, col) =>
    Math.max(h.length, ...formatted.map((row) => row[col].length), totalsRow[col].length)
  );

  const pad = (row: string[]): string =>
    row
      .map((cell, col) => (col === 0 ? cell.padEnd(widths[col]) : cell.padStart(widths[col])))
      .join("  ");

  const separator = widths.map((w) => "─".repeat(w)).join("  ");

  const lines: string[] = [];
  lines.push(title);
  lines.push(pad(headers));
  lines.push(separator);
  for (const row of formatted) {
    lines.push(pad(row));
  }
  lines.push(separator);
  lines.push(pad(totalsRow));
  lines.push("");
  return lines.join("\n");
}

function formatKb(bytes: number): string {
  if (bytes === 0) return "0";
  const kb = bytes / 1024;
  if (kb < 10) return kb.toFixed(1);
  return Math.round(kb).toString();
}

function formatTruncated(row: CondenseStatsRow): string {
  return `${row.truncatedCount}/${row.count}`;
}
