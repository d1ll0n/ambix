import { Session } from "parse-claude-logs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildTokenDensityTimeline } from "../../src/analyze/token-density.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("buildTokenDensityTimeline", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("produces one [ix, total] pair per assistant entry", async () => {
    const text = joinLines(
      userLine({ text: "hi" }),
      assistantLine({ text: "a", inputTokens: 100, outputTokens: 50 }),
      userLine({ text: "more" }),
      assistantLine({ text: "b", inputTokens: 200, outputTokens: 75 })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const timeline = buildTokenDensityTimeline(entries);

    expect(timeline).toEqual([
      [1, 150],
      [3, 275],
    ]);
  });

  it("skips non-assistant entries", async () => {
    const text = joinLines(userLine({ text: "alone" }), userLine({ text: "also" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    expect(buildTokenDensityTimeline(entries)).toEqual([]);
  });

  it("excludes synthetic model entries", async () => {
    const text = joinLines(
      assistantLine({ text: "real", model: "claude-sonnet-4-6", inputTokens: 10, outputTokens: 5 }),
      assistantLine({ text: "fake", model: "<synthetic>", inputTokens: 999, outputTokens: 999 })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const timeline = buildTokenDensityTimeline(entries);
    expect(timeline).toEqual([[0, 15]]);
  });
});
