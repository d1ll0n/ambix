import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregateTokens } from "../../src/analyze/tokens.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("aggregateTokens", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("sums input/output/cache tokens per model and overall", async () => {
    const text = joinLines(
      userLine({ text: "hi" }),
      assistantLine({
        text: "a",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
      }),
      assistantLine({
        text: "b",
        model: "claude-sonnet-4-6",
        inputTokens: 200,
        outputTokens: 75,
        cacheReadTokens: 20,
      }),
      assistantLine({ text: "c", model: "claude-opus-4-6", inputTokens: 500, outputTokens: 300 })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));

    const result = await aggregateTokens(session);

    expect(result.by_model["claude-sonnet-4-6"].in).toBe(300);
    expect(result.by_model["claude-sonnet-4-6"].out).toBe(125);
    expect(result.by_model["claude-sonnet-4-6"].cache_read).toBe(30);
    expect(result.by_model["claude-sonnet-4-6"].message_count).toBe(2);
    expect(result.by_model["claude-opus-4-6"].in).toBe(500);
    expect(result.by_model["claude-opus-4-6"].message_count).toBe(1);
    expect(result.totals.in).toBe(800);
    expect(result.totals.out).toBe(425);
  });

  it("returns zero totals for a session with no assistant entries", async () => {
    const text = joinLines(userLine({ text: "alone" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const result = await aggregateTokens(session);
    expect(result.totals).toEqual({ in: 0, out: 0, cache_read: 0, cache_write: 0 });
    expect(Object.keys(result.by_model)).toHaveLength(0);
  });

  it("excludes <synthetic> model entries from per-model counts", async () => {
    const text = joinLines(
      assistantLine({
        text: "real",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
      }),
      assistantLine({ text: "fake", model: "<synthetic>", inputTokens: 999, outputTokens: 999 })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const result = await aggregateTokens(session);
    expect(result.by_model["claude-sonnet-4-6"].in).toBe(100);
    expect(result.by_model["<synthetic>"]).toBeUndefined();
    expect(result.totals.in).toBe(100);
    expect(result.totals.out).toBe(50);
  });
});
