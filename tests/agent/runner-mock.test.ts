import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lintNarrative } from "../../src/agent/lint.js";
import { MockAgentRunner } from "../../src/agent/runner-mock.js";
import { cleanupTempDir, makeTempDir } from "../helpers/fixtures.js";

describe("MockAgentRunner", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  function setupTmp(turnCount: number): void {
    mkdirSync(path.join(dir, "out"), { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < turnCount; i++) {
      lines.push(
        JSON.stringify({
          ix: i,
          ref: `uuid:${i}`,
          role: "user",
          type: "user",
          ts: null,
          content: `t${i}`,
        })
      );
    }
    writeFileSync(path.join(dir, "session.jsonl"), `${lines.join("\n")}\n`);
    writeFileSync(
      path.join(dir, "metadata.json"),
      JSON.stringify({ session_id: "sess", turn_count: turnCount, end_state: "completed" })
    );
  }

  it("writes a valid narrative.json that passes lintNarrative", async () => {
    setupTmp(3);
    const runner = new MockAgentRunner();
    const result = await runner.run({
      tmpDir: dir,
      systemPrompt: "irrelevant",
      initialMessage: "distill it",
    });
    expect(result.success).toBe(true);
    expect(existsSync(path.join(dir, "out", "narrative.json"))).toBe(true);
    const errors = await lintNarrative(dir);
    expect(errors).toEqual([]);
  });

  it("reports turnCount and tokensUsed in the result", async () => {
    setupTmp(2);
    const runner = new MockAgentRunner();
    const result = await runner.run({
      tmpDir: dir,
      systemPrompt: "irrelevant",
      initialMessage: "distill it",
    });
    expect(result.turnCount).toBeGreaterThan(0);
    expect(result.tokensUsed).toBeDefined();
  });

  it("honors followUpMessages by producing a slightly different narrative on retry", async () => {
    setupTmp(2);
    const runner = new MockAgentRunner();
    const first = await runner.run({
      tmpDir: dir,
      systemPrompt: "x",
      initialMessage: "go",
    });
    expect(first.success).toBe(true);
    const firstJson = readFileSync(path.join(dir, "out", "narrative.json"), "utf8");

    const second = await runner.run({
      tmpDir: dir,
      systemPrompt: "x",
      initialMessage: "go",
      followUpMessages: ["fix refs[0]"],
    });
    expect(second.success).toBe(true);
    const secondJson = readFileSync(path.join(dir, "out", "narrative.json"), "utf8");
    expect(secondJson).not.toBe(firstJson);
  });
});
