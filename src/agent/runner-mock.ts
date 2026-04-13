// src/agent/runner-mock.ts
import { writeFile, readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { AgentRunContext, AgentRunResult, AgentRunner } from "./types.js";
import type { Narrative } from "../artifact/types.js";

/**
 * A mock AgentRunner that produces a minimal valid narrative without
 * actually calling a model. Used for end-to-end pipeline tests and as
 * a smoke-test harness before wiring up the real SDK.
 *
 * The mock reads `metadata.json` to get the session's turn_count, then
 * writes a narrative that:
 *   - Has a non-empty summary
 *   - Has one main_task with refs pointing at ix=0
 *   - Has one episode spanning ix_range [0, turn_count-1]
 *   - Has verification.was_verified=false
 *   - Empty decisions/corrections/friction_points/wins/unresolved
 *
 * Retries (signaled by `followUpMessages` being set) append a "(retry N)"
 * marker to the summary so callers can detect that a retry happened.
 */
export class MockAgentRunner implements AgentRunner {
  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    const metadataPath = path.join(ctx.tmpDir, "metadata.json");
    let turnCount = 1;
    try {
      const meta = JSON.parse(await readFile(metadataPath, "utf8")) as { turn_count?: number };
      if (typeof meta.turn_count === "number" && meta.turn_count > 0) {
        turnCount = meta.turn_count;
      }
    } catch {
      // use default
    }

    const retryCount = ctx.followUpMessages?.length ?? 0;
    const suffix = retryCount > 0 ? ` (retry ${retryCount})` : "";

    const narrative: Narrative = {
      summary: `Mock distillation of ${turnCount}-turn session.${suffix}`,
      main_tasks: [
        {
          title: "Mock main task",
          status: "completed",
          description: "Placeholder produced by MockAgentRunner.",
          refs: [0],
        },
      ],
      episodes: [
        {
          title: "Full session",
          kind: "other",
          ix_range: [0, Math.max(0, turnCount - 1)],
          summary: "Mock episode covering the entire session.",
          refs: [0],
        },
      ],
      decisions: [],
      corrections: [],
      verification: {
        was_verified: false,
        how: "Mock runner does not verify.",
        refs: [0],
      },
      friction_points: [],
      wins: [],
      unresolved: [],
    };

    const outDir = path.join(ctx.tmpDir, "out");
    await mkdir(outDir, { recursive: true });
    await writeFile(
      path.join(outDir, "narrative.json"),
      JSON.stringify(narrative, null, 2),
      "utf8"
    );

    return {
      success: true,
      turnCount: 1 + retryCount,
      tokensUsed: { in: 0, out: 0 },
    };
  }
}
