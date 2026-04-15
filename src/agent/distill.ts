// src/agent/distill.ts
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { lintNarrative } from "./lint.js";
import { buildSystemPrompt } from "./system-prompt.js";
import type { AgentRunResult, AgentRunner } from "./types.js";

/** Options for the distill coordinator. */
export interface DistillOptions {
  tmpDir: string;
  runner: AgentRunner;
  /** Maximum number of retries after an initial failed lint. Default 2. */
  maxRetries?: number;
}

/** Result of a distillation. */
export interface DistillResult {
  success: boolean;
  retries: number;
  lintErrors?: string[];
  error?: string;
  tokensUsed?: { in: number; out: number };
}

/**
 * Maximum size of the condensed session.jsonl that we will inline into
 * the agent's initial user message. Above this, we fall back to telling
 * the agent to Read the file from disk (paginating with offset/limit).
 *
 * 200KB ≈ 50k tokens — comfortably within Sonnet/Haiku context budget
 * even after the system prompt, tool schemas, and the agent's growing
 * scratch context.
 */
const MAX_INLINE_CONDENSED_BYTES = 200_000;

/**
 * Spawn the distiller runner, validate its output, and retry on lint
 * failure up to `maxRetries` times.
 */
export async function distill(opts: DistillOptions): Promise<DistillResult> {
  const maxRetries = opts.maxRetries ?? 2;

  const { initialMessage, inlinedCondensed } = await buildInitialMessage(opts.tmpDir);
  const systemPrompt = await buildSystemPrompt({ tmpDir: opts.tmpDir, inlinedCondensed });

  let retries = 0;
  let followUps: string[] = [];
  let cumulativeIn = 0;
  let cumulativeOut = 0;

  while (true) {
    let runResult: AgentRunResult;
    try {
      runResult = await opts.runner.run({
        tmpDir: opts.tmpDir,
        systemPrompt,
        initialMessage,
        followUpMessages: followUps.length > 0 ? followUps : undefined,
      });
    } catch (err) {
      return {
        success: false,
        retries,
        error: err instanceof Error ? err.message : String(err),
        tokensUsed: { in: cumulativeIn, out: cumulativeOut },
      };
    }

    if (runResult.tokensUsed) {
      cumulativeIn += runResult.tokensUsed.in;
      cumulativeOut += runResult.tokensUsed.out;
    }

    if (!runResult.success) {
      return {
        success: false,
        retries,
        error: runResult.error,
        tokensUsed: { in: cumulativeIn, out: cumulativeOut },
      };
    }

    const lintErrors = await lintNarrative(opts.tmpDir);
    if (lintErrors.length === 0) {
      return {
        success: true,
        retries,
        tokensUsed: { in: cumulativeIn, out: cumulativeOut },
      };
    }

    if (retries >= maxRetries) {
      return {
        success: false,
        retries,
        lintErrors,
        tokensUsed: { in: cumulativeIn, out: cumulativeOut },
      };
    }

    retries++;
    followUps = [buildRetryMessage(lintErrors)];
  }
}

/**
 * Build the initial user message for the distiller agent.
 *
 * For sessions whose condensed log fits under the inline threshold,
 * the full metadata.json + session.jsonl are embedded directly in the
 * message so the agent never has to spend a tool round-trip reading
 * them. For oversized sessions, the message tells the agent to read
 * the files from disk with pagination.
 */
async function buildInitialMessage(
  tmpDir: string
): Promise<{ initialMessage: string; inlinedCondensed: boolean }> {
  const metadataPath = path.join(tmpDir, "metadata.json");
  const sessionPath = path.join(tmpDir, "session.jsonl");

  const sessionStat = await stat(sessionPath);
  const inlineCondensed = sessionStat.size <= MAX_INLINE_CONDENSED_BYTES;

  if (inlineCondensed) {
    const [metadata, sessionContent] = await Promise.all([
      readFile(metadataPath, "utf8"),
      readFile(sessionPath, "utf8"),
    ]);
    const message = `Please distill this Claude Code session into the structured narrative at out/narrative.json.

The session metadata and the entire condensed log are inlined below — work from this content directly. Rehydrate full turn entries (Read \`turns/NNNNN.json\` or \`spill/...\`) only when a truncation \`preview\` is genuinely insufficient. Subagent files live under \`subagents/agent-<uuid>/session.jsonl\` and follow the same rule.

Run \`bin/lint-output\` before declaring done.

## metadata.json

\`\`\`json
${metadata.trimEnd()}
\`\`\`

## session.jsonl (condensed log, ${sessionStat.size} bytes)

\`\`\`jsonl
${sessionContent.trimEnd()}
\`\`\`
`;
    return { initialMessage: message, inlinedCondensed: true };
  }

  const message = `Please distill this Claude Code session into the structured narrative at out/narrative.json.

The condensed session log is large (${sessionStat.size} bytes) and is NOT inlined. Read \`metadata.json\` first, then read \`session.jsonl\` (paginate with offset/limit if it exceeds a single Read). Rehydrate \`turns/NNNNN.json\` (or \`spill/...\`) only when a truncation \`preview\` is genuinely insufficient. Subagent files live under \`subagents/agent-<uuid>/session.jsonl\` and follow the same rule.

Run \`bin/lint-output\` before declaring done.`;
  return { initialMessage: message, inlinedCondensed: false };
}

function buildRetryMessage(errors: string[]): string {
  return `The narrative you wrote has validation errors. Please fix them and re-run bin/lint-output before finishing:\n\n${errors.map((e) => `- ${e}`).join("\n")}`;
}
