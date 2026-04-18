// src/compact-session/stub.ts
import type { ToolResultBlock } from "parse-cc";
import { condenseToolUse, toolResultText } from "../../../brief/condensers.js";

export interface BuildStubOptions {
  /** Session UUID of the ORIGINAL (pre-compaction) session. */
  origSessionId: string;
  /** Turn index in the original session (what `ambix query <id> <ix>` takes). */
  ix: number;
  /** Tool name from the paired tool_use block. */
  toolName: string;
  /** Tool input from the paired tool_use block (passed to condenser). */
  toolInput: unknown;
  /** The tool_result whose content is being replaced (for condenser flavor). */
  originalResult: ToolResultBlock | null;
  /**
   * Command prefix used in the stub text. Default `"ambix query"`. Override
   * in tests or if an operator needs an absolute path.
   */
  ambixCmd?: string;
}

/** Size in bytes of a tool_result's content when flattened to text. */
export function measureToolResultBytes(result: ToolResultBlock | null): number {
  if (!result) return 0;
  return Buffer.byteLength(toolResultText(result), "utf8");
}

/**
 * Build the stub string that replaces a compacted tool_result's `content`.
 *
 * Format:
 *   [COMPACTION STUB — <condenser one-liner>, ~<N> bytes removed.
 *    Retrieve via: ambix query <orig-session-id> <ix>]
 *
 * The agent reading this stub is expected to:
 *   1. Recognize it as a truncation marker (not real tool output)
 *   2. Run the `ambix query` command when it needs the actual content
 *
 * Validated end-to-end against Claude Code 2.1.110 on 2026-04-17 — see
 * docs/specs/2026-04-17-compact-to-session.md § Validation log.
 */
export function buildStub(opts: BuildStubOptions): string {
  const cmd = opts.ambixCmd ?? "ambix query";
  const summary = condenseToolUse(opts.toolName, opts.toolInput, opts.originalResult);
  const bytes = measureToolResultBytes(opts.originalResult);
  return [
    `[COMPACTION STUB — ${summary}, ~${bytes} bytes removed.`,
    ` Retrieve via: ${cmd} ${opts.origSessionId} ${opts.ix}]`,
  ].join("\n");
}
