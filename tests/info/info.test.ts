import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { formatSessionInfo } from "../../src/info/format.js";
import { sessionInfo } from "../../src/info/index.js";
import {
  FIXTURE_SESSION_ID,
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("sessionInfo", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("combines metadata and token rollup", async () => {
    const text = joinLines(
      userLine({
        text: "hi",
        ts: "2026-04-13T10:00:00Z",
        cwd: "/work/proj",
        gitBranch: "feature/x",
        version: "2.1.97",
      }),
      assistantLine({
        text: "one",
        ts: "2026-04-13T10:01:00Z",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
      }),
      assistantLine({
        text: "two",
        ts: "2026-04-13T10:05:00Z",
        model: "claude-opus-4-7",
        inputTokens: 500,
        outputTokens: 300,
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));

    const info = await sessionInfo(session);

    expect(info.metadata.session_id).toBe(FIXTURE_SESSION_ID);
    expect(info.metadata.cwd).toBe("/work/proj");
    expect(info.metadata.git_branch).toBe("feature/x");
    expect(info.metadata.turn_count).toBe(3);
    expect(info.metadata.duration_s).toBe(300);

    expect(info.tokens.totals.in).toBe(600);
    expect(info.tokens.totals.out).toBe(350);
    expect(info.tokens.totals.cache_read).toBe(10);
    expect(info.tokens.by_model["claude-sonnet-4-6"].message_count).toBe(1);
    expect(info.tokens.by_model["claude-opus-4-7"].message_count).toBe(1);
  });

  it("handles a session with no assistant turns", async () => {
    const text = joinLines(userLine({ text: "alone", ts: "2026-04-13T10:00:00Z" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));

    const info = await sessionInfo(session);

    expect(info.metadata.turn_count).toBe(1);
    expect(info.tokens.totals).toEqual({ in: 0, out: 0, cache_read: 0, cache_write: 0 });
    expect(Object.keys(info.tokens.by_model)).toHaveLength(0);
  });
});

describe("formatSessionInfo", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("renders metadata header and per-model token rows", async () => {
    const text = joinLines(
      userLine({
        text: "hi",
        ts: "2026-04-13T10:00:00Z",
        cwd: "/work/proj",
        gitBranch: "feature/x",
        version: "2.1.97",
      }),
      assistantLine({
        text: "reply",
        ts: "2026-04-13T10:05:00Z",
        model: "claude-sonnet-4-6",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const info = await sessionInfo(session);

    const out = formatSessionInfo(info);

    expect(out).toContain("session:");
    expect(out).toContain(FIXTURE_SESSION_ID);
    expect(out).toContain("version:");
    expect(out).toContain("2.1.97");
    expect(out).toContain("branch:");
    expect(out).toContain("feature/x");
    expect(out).toContain("turns:");
    expect(out).toContain("2 (completed)");
    expect(out).toContain("duration:");
    expect(out).toContain("5m 0s");
    expect(out).toContain("tokens:");
    expect(out).toContain("totals");
    expect(out).toContain("in=100");
    expect(out).toContain("out=50");
    expect(out).toContain("cache_read=10");
    expect(out).toContain("claude-sonnet-4-6 (1 msgs)");
  });

  it("omits optional metadata fields when null and renders empty token block", async () => {
    const text = joinLines(userLine({ text: "alone", ts: "2026-04-13T10:00:00Z" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const info = await sessionInfo(session);

    const out = formatSessionInfo(info);

    expect(out).toContain(FIXTURE_SESSION_ID);
    expect(out).toContain("tokens:");
    // Totals row still present with zeros
    expect(out).toContain("in=0");
  });

  it("formats multi-hour durations", async () => {
    const text = joinLines(
      userLine({ text: "hi", ts: "2026-04-13T10:00:00Z" }),
      assistantLine({ text: "later", ts: "2026-04-13T12:03:10Z" })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const info = await sessionInfo(session);

    const out = formatSessionInfo(info);

    expect(out).toContain("2h 3m 10s");
  });
});
