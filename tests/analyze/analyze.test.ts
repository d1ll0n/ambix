import { Session } from "parse-claude-logs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyze } from "../../src/analyze/index.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  toolUseAssistantLine,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("analyze", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("produces a fully-populated AnalyzeResult for a small session", async () => {
    const text = joinLines(
      userLine({ text: "hi" }),
      assistantLine({
        text: "hello",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
      }),
      toolUseAssistantLine({
        name: "Read",
        input: { file_path: "src/a.ts" },
        inputTokens: 0,
        outputTokens: 0,
      }),
      toolUseAssistantLine({
        name: "Bash",
        input: { command: "git status" },
        inputTokens: 0,
        outputTokens: 0,
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));

    const result = await analyze(session);

    expect(result.tokens.totals.in).toBe(100);
    expect(result.tools.invocations).toEqual({ Read: 1, Bash: 1 });
    expect(result.files.touched).toHaveLength(1);
    expect(result.files.read_without_write).toEqual(["src/a.ts"]);
    expect(result.bash_clusters).toHaveLength(1);
    expect(result.bash_clusters[0].pattern).toBe("git");
    expect(result.churn_timeline).toHaveLength(1);
    expect(result.failures).toEqual([]);
    expect(result.spill_files).toEqual([]);
    expect(result.permission_events).toEqual([]);
    expect(result.subagents).toEqual([]);
    expect(result.compaction_phases).toBeDefined();
    expect(result.token_density_timeline.length).toBeGreaterThan(0);
  });

  it("produces an empty-shaped result for a minimal user-only session", async () => {
    const text = joinLines(userLine({ text: "alone" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));

    const result = await analyze(session);

    expect(result.tokens.totals.in).toBe(0);
    expect(result.tools.invocations).toEqual({});
    expect(result.files.touched).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.token_density_timeline).toEqual([]);
  });
});
