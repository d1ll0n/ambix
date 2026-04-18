// src/compact-session/summary.ts
import { randomUUID } from "node:crypto";

export interface BuildSummaryOptions {
  /** Original (source) session's UUID — cited in the rehydration instructions. */
  origSessionId: string;
  /** New (compacted) session's UUID. Written as sessionId on the entry. */
  newSessionId: string;
  /** parentUuid for the divider entry. Null if condensed section is empty. */
  parentUuid: string | null;
  /** Copied from source for consistency across the file. */
  cwd: string;
  gitBranch: string;
  version: string;
  /**
   * Last source ix included in the condensed section. Pass -1 when the
   * condensed section is empty (everything fits in the preserved window).
   */
  condensedLastIx: number;
  /**
   * First source ix in the preserved section. Pass > lastSourceIx when
   * the preserved section is empty (`--full-recent 0`).
   */
  preservedFirstIx: number;
  /** Last source ix in the source session (inclusive). */
  lastSourceIx: number;
  /** The N value used. */
  fullRecent: number;
  /** Override timestamp (ISO string). Default: `new Date().toISOString()`. */
  now?: string;
  /** Override uuid (for deterministic tests). Default: generated. */
  uuid?: string;
  /** Override promptId (for deterministic tests). Default: generated. */
  promptId?: string;
}

/**
 * Construct the divider entry — a plain user message whose content is the
 * explanatory prose for the compaction.
 *
 * Not marked `isCompactSummary: true`: CC treats that flag as a "pre-divider
 * history is compacted, do not feed to model" signal. Observed empirically
 * on 2026-04-17 — with the flag set on a real session that had post-divider
 * entries, CC hid both the summary and the condensed stubbed entries from the
 * model, defeating the whole point of structural preservation. Leaving the
 * flag off makes the divider a normal-looking user turn; pre-divider stubs
 * and the summary prose both reach the model's context.
 */
export function buildSummaryEntry(opts: BuildSummaryOptions): Record<string, unknown> {
  const uuid = opts.uuid ?? randomUUID();
  const promptId = opts.promptId ?? randomUUID();
  const timestamp = opts.now ?? new Date().toISOString();

  return {
    parentUuid: opts.parentUuid,
    isSidechain: false,
    promptId,
    type: "user",
    message: {
      role: "user",
      content: renderSummaryContent(opts),
    },
    uuid,
    timestamp,
    userType: "external",
    entrypoint: "cli",
    cwd: opts.cwd,
    sessionId: opts.newSessionId,
    version: opts.version,
    gitBranch: opts.gitBranch,
  };
}

function renderSummaryContent(opts: BuildSummaryOptions): string {
  const hasCondensed = opts.condensedLastIx >= 0;
  const hasPreserved = opts.preservedFirstIx <= opts.lastSourceIx;

  const lines: string[] = [
    "<ambix-compaction-marker>",
    `This session was compacted by ambix from ${opts.origSessionId}.`,
    "",
  ];

  if (hasCondensed) {
    lines.push(
      `Above this divider: turns 0–${opts.condensedLastIx} with tool_result outputs replaced by COMPACTION STUBS.`,
      "Each stub carries an `ambix query` command that retrieves the original content.",
      ""
    );
  } else {
    lines.push(
      "No turns are condensed in this file — the full source fits within the preserved window.",
      ""
    );
  }

  if (hasPreserved) {
    lines.push(
      `Below this divider: turns ${opts.preservedFirstIx}–${opts.lastSourceIx} preserved verbatim (the last ${opts.fullRecent} rounds of the source conversation).`,
      ""
    );
  } else {
    lines.push(
      "No turns preserved verbatim (--full-recent 0) — every pre-compaction tool_result is stubbed.",
      ""
    );
  }

  lines.push(
    "Do NOT infer or guess what stubbed tool_results contained — the stub text is a placeholder, not the real output. Run the embedded command when you need the actual content.",
    "",
    "Continue the conversation from where it left off.",
    "</ambix-compaction-marker>"
  );

  return lines.join("\n");
}
