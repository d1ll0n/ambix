// src/compact/render.ts
//
// Two renderers that take a sequence of `Round`s and produce either
// XML-tagged or markdown-styled compaction output. The XML variant is
// the primary artifact (intended for LLM consumption as a
// context-recovery input); the markdown variant is for humans reading
// in a terminal or editor.

import type { ToolResultBlock } from "parse-claude-logs";
import { iterRoundStream, roundBranch, type Round } from "./rounds.js";

export type CompactFormat = "xml" | "markdown";

export interface RenderOptions {
  source: string;
  totalRounds: number;
  assistantTextTokens: number;
  toolUseCount: number;
}

/** Render a header block describing the session + compaction stats. */
function renderHeader(fmt: CompactFormat, opts: RenderOptions): string {
  if (fmt === "xml") {
    return (
      `<session source="${opts.source}" ` +
      `rounds="${opts.totalRounds}" ` +
      `assistant_text_tokens="${opts.assistantTextTokens}" ` +
      `tool_uses="${opts.toolUseCount}">\n`
    );
  }
  return [
    "# Session compaction",
    "",
    `**Source:** \`${opts.source}\``,
    `**Rounds:** ${opts.totalRounds}  •  **Assistant text:** ~${opts.assistantTextTokens} tok  •  **Tool uses:** ${opts.toolUseCount}`,
    "",
    "---",
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// XML renderer
// ---------------------------------------------------------------------------

function renderRoundXml(
  round: Round,
  resultsById: Map<string, ToolResultBlock>,
  roundIx: number,
  prevBranch: string | null
): string {
  const lines: string[] = [];
  lines.push(`<round n="${roundIx}">`);
  lines.push(`<user idx="${round.userIx}">`);
  lines.push(round.userText.trim());
  lines.push("</user>");

  const branch = roundBranch(round);
  if (branch && branch !== prevBranch) {
    lines.push(`<git branch="${branch}"/>`);
  }

  // Group consecutive tool_uses into a single <tools idx="A-B"> block.
  const pending: Array<{ line: string; ix: number }> = [];
  const flushTools = () => {
    if (pending.length === 0) return;
    const ixes = pending.map((p) => p.ix);
    const lo = Math.min(...ixes);
    const hi = Math.max(...ixes);
    const span = lo === hi ? `${lo}` : `${lo}-${hi}`;
    lines.push(`<tools idx="${span}">`);
    for (const { line, ix } of pending) lines.push(`- [${ix}] ${line}`);
    lines.push("</tools>");
    pending.length = 0;
  };

  for (const item of iterRoundStream(round, resultsById)) {
    if (item.kind === "tool") {
      pending.push({ line: item.payload, ix: item.ix });
    } else {
      flushTools();
      lines.push(`<assistant idx="${item.ix}">`);
      lines.push(item.payload);
      lines.push("</assistant>");
    }
  }
  flushTools();

  lines.push("</round>");
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Markdown renderer
// ---------------------------------------------------------------------------

function renderRoundMarkdown(
  round: Round,
  resultsById: Map<string, ToolResultBlock>,
  roundIx: number,
  prevBranch: string | null
): string {
  const lines: string[] = [];
  lines.push(`## Round ${roundIx}`);
  lines.push("");
  lines.push(`**User** \`[ix ${round.userIx}]\``);
  lines.push("");
  lines.push(`> ${round.userText.trim().replace(/\n/g, "\n> ")}`);
  lines.push("");

  const branch = roundBranch(round);
  if (branch && branch !== prevBranch) {
    lines.push(`*on \`${branch}\`*`);
    lines.push("");
  }

  const pending: Array<{ line: string; ix: number }> = [];
  const flushTools = () => {
    if (pending.length === 0) return;
    const ixes = pending.map((p) => p.ix);
    const lo = Math.min(...ixes);
    const hi = Math.max(...ixes);
    const span = lo === hi ? `${lo}` : `${lo}-${hi}`;
    lines.push(`**Tools** \`[ix ${span}]\``);
    for (const { line, ix } of pending) lines.push(`- [${ix}] ${line}`);
    lines.push("");
    pending.length = 0;
  };

  for (const item of iterRoundStream(round, resultsById)) {
    if (item.kind === "tool") {
      pending.push({ line: item.payload, ix: item.ix });
    } else {
      flushTools();
      lines.push(`**Assistant** \`[ix ${item.ix}]\``);
      lines.push("");
      lines.push(item.payload);
      lines.push("");
    }
  }
  flushTools();
  lines.push("");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Top-level
// ---------------------------------------------------------------------------

/**
 * Render every round + a session header in the requested format.
 * Tracks `prevBranch` across rounds so the `<git branch="...">` marker
 * only fires on actual branch changes.
 */
export function renderCompact(
  fmt: CompactFormat,
  rounds: Round[],
  resultsById: Map<string, ToolResultBlock>,
  headerOpts: RenderOptions
): string {
  const chunks: string[] = [renderHeader(fmt, headerOpts)];
  let prevBranch: string | null = null;
  const renderRound = fmt === "xml" ? renderRoundXml : renderRoundMarkdown;
  for (let i = 0; i < rounds.length; i++) {
    chunks.push(renderRound(rounds[i], resultsById, i + 1, prevBranch));
    const b = roundBranch(rounds[i]);
    if (b) prevBranch = b;
  }
  if (fmt === "xml") chunks.push("</session>\n");
  return chunks.join("");
}
