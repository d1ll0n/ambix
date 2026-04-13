import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { run } from "../../src/orchestrate/run.js";
import { MockAgentRunner } from "../../src/agent/runner-mock.js";
import {
  makeTempDir,
  cleanupTempDir,
  joinLines,
  userLine,
  assistantLine,
} from "../helpers/fixtures.js";
import type { Artifact } from "../../src/artifact/types.js";

describe("run end-to-end with mock runner", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("stages + analyzes + distills + merges + persists an artifact for a minimal session", async () => {
    const sessionPath = path.join(dir, "session.jsonl");
    writeFileSync(
      sessionPath,
      joinLines(
        userLine({ text: "hi", uuid: "u1" }),
        assistantLine({ text: "hello", uuid: "a1", parentUuid: "u1" })
      )
    );

    const outputRoot = path.join(dir, "alembic-home");
    const tmpRoot = path.join(dir, "tmp-root");

    const result = await run({
      session: sessionPath,
      outputRoot,
      tmpRoot,
      runner: new MockAgentRunner(),
    });

    expect(result.success).toBe(true);
    expect(result.artifactPath).toBeDefined();
    expect(existsSync(result.artifactPath!)).toBe(true);

    const artifact = JSON.parse(readFileSync(result.artifactPath!, "utf8")) as Artifact;
    expect(artifact.schema_version).toBe("1");
    expect(artifact.metadata.turn_count).toBe(2);
    expect(artifact.deterministic.tools).toBeDefined();
    expect(artifact.narrative.summary).toBeTruthy();

    expect(result.tokensUsed).toBeDefined();
    expect(result.sourceTokens).toBeDefined();
    expect(result.sourceTokens!.in).toBeGreaterThanOrEqual(0);
  });

  it("cleans up the tmp directory on success", async () => {
    const sessionPath = path.join(dir, "session.jsonl");
    writeFileSync(sessionPath, joinLines(userLine({ text: "x", uuid: "u1" })));

    const tmpRoot = path.join(dir, "tmp-root");
    const outputRoot = path.join(dir, "alembic-home");

    const result = await run({
      session: sessionPath,
      outputRoot,
      tmpRoot,
      runner: new MockAgentRunner(),
    });

    expect(result.success).toBe(true);
    expect(existsSync(result.tmpDir!)).toBe(false);
  });

  it("retains the tmp directory when keepTmp=true", async () => {
    const sessionPath = path.join(dir, "session.jsonl");
    writeFileSync(sessionPath, joinLines(userLine({ text: "x", uuid: "u1" })));

    const tmpRoot = path.join(dir, "tmp-root");
    const outputRoot = path.join(dir, "alembic-home");

    const result = await run({
      session: sessionPath,
      outputRoot,
      tmpRoot,
      runner: new MockAgentRunner(),
      keepTmp: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(result.tmpDir!)).toBe(true);
  });

  it("retains the tmp directory on failure even without keepTmp", async () => {
    const sessionPath = path.join(dir, "session.jsonl");
    writeFileSync(sessionPath, joinLines(userLine({ text: "x", uuid: "u1" })));

    const tmpRoot = path.join(dir, "tmp-root");
    const outputRoot = path.join(dir, "alembic-home");

    const brokenRunner = {
      async run() {
        return { success: false, error: "boom", turnCount: 0 };
      },
    };

    const result = await run({
      session: sessionPath,
      outputRoot,
      tmpRoot,
      runner: brokenRunner,
      keepTmp: false,
    });

    expect(result.success).toBe(false);
    expect(existsSync(result.tmpDir!)).toBe(true);
  });
});
