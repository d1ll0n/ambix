import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { distill } from "../../src/agent/distill.js";
import { MockAgentRunner } from "../../src/agent/runner-mock.js";
import { makeTempDir, cleanupTempDir } from "../helpers/fixtures.js";
import type { AgentRunContext, AgentRunResult, AgentRunner } from "../../src/agent/types.js";

describe("distill coordinator", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  function setupTmp(turnCount = 2): void {
    mkdirSync(path.join(dir, "out"), { recursive: true });
    mkdirSync(path.join(dir, "bin"), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < turnCount; i++) {
      lines.push(JSON.stringify({ ix: i, ref: `uuid:${i}`, role: "user", type: "user", ts: null, content: "x" }));
    }
    writeFileSync(path.join(dir, "session.jsonl"), lines.join("\n") + "\n");
    writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({ session_id: "sess", turn_count: turnCount, end_state: "completed" })
    );
  }

  it("succeeds when the runner produces a valid narrative on first try", async () => {
    setupTmp(2);
    const result = await distill({
      tmpDir: dir,
      runner: new MockAgentRunner(),
    });
    expect(result.success).toBe(true);
    expect(result.retries).toBe(0);
    expect(existsSync(path.join(dir, "out", "narrative.json"))).toBe(true);
  });

  it("retries when lint fails, up to maxRetries times, and succeeds if a later attempt is valid", async () => {
    setupTmp(2);
    let attempts = 0;
    const flakyRunner: AgentRunner = {
      async run(ctx: AgentRunContext): Promise<AgentRunResult> {
        attempts++;
        const outPath = path.join(ctx.tmpDir, "out", "narrative.json");
        if (attempts < 2) {
          const { writeFile, mkdir } = await import("node:fs/promises");
          await mkdir(path.dirname(outPath), { recursive: true });
          await writeFile(outPath, JSON.stringify({ main_tasks: [], episodes: [], decisions: [], corrections: [], verification: { was_verified: false, how: "", refs: [] }, friction_points: [], wins: [], unresolved: [] }));
        } else {
          await new MockAgentRunner().run(ctx);
        }
        return { success: true, turnCount: 1 };
      },
    };

    const result = await distill({ tmpDir: dir, runner: flakyRunner, maxRetries: 2 });
    expect(result.success).toBe(true);
    expect(result.retries).toBe(1);
    expect(attempts).toBe(2);
  });

  it("gives up after maxRetries when lint keeps failing", async () => {
    setupTmp(2);
    const alwaysBad: AgentRunner = {
      async run(ctx: AgentRunContext): Promise<AgentRunResult> {
        const { writeFile, mkdir } = await import("node:fs/promises");
        await mkdir(path.join(ctx.tmpDir, "out"), { recursive: true });
        await writeFile(
          path.join(ctx.tmpDir, "out", "narrative.json"),
          JSON.stringify({ summary: "x" })
        );
        return { success: true, turnCount: 1 };
      },
    };

    const result = await distill({ tmpDir: dir, runner: alwaysBad, maxRetries: 2 });
    expect(result.success).toBe(false);
    expect(result.retries).toBe(2);
    expect(result.lintErrors).toBeDefined();
    expect(result.lintErrors!.length).toBeGreaterThan(0);
  });

  it("reports failure when the runner itself errors", async () => {
    setupTmp(2);
    const throwing: AgentRunner = {
      async run(): Promise<AgentRunResult> {
        return { success: false, error: "api down", turnCount: 0 };
      },
    };
    const result = await distill({ tmpDir: dir, runner: throwing });
    expect(result.success).toBe(false);
    expect(result.error).toBe("api down");
  });
});
