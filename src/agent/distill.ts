// src/agent/distill.ts
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

const INITIAL_MESSAGE = `Please distill this Claude Code session into the structured narrative at out/narrative.json. Start by reading metadata.json, then read session.jsonl linearly. Consult turns/, spill/, and subagents/ when the inline preview isn't enough. Run bin/lint-output before declaring done.`;

/**
 * Spawn the distiller runner, validate its output, and retry on lint
 * failure up to `maxRetries` times.
 */
export async function distill(opts: DistillOptions): Promise<DistillResult> {
  const maxRetries = opts.maxRetries ?? 2;
  const systemPrompt = await buildSystemPrompt({ tmpDir: opts.tmpDir });

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
        initialMessage: INITIAL_MESSAGE,
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

function buildRetryMessage(errors: string[]): string {
  return `The narrative you wrote has validation errors. Please fix them and re-run bin/lint-output before finishing:\n\n${errors.map((e) => `- ${e}`).join("\n")}`;
}
