import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { computeDistillerUsageFromLog } from "../../src/orchestrate/compute-distiller-usage.js";
import {
  makeTempDir,
  cleanupTempDir,
  joinLines,
  assistantLine,
  userLine,
} from "../helpers/fixtures.js";

describe("computeDistillerUsageFromLog", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("sums tokens across all .jsonl files in the log directory", async () => {
    const logDir = path.join(dir, "distiller-log");
    mkdirSync(logDir, { recursive: true });

    writeFileSync(
      path.join(logDir, "session-a.jsonl"),
      joinLines(
        userLine({ text: "hi", sessionId: "a", uuid: "u1" }),
        assistantLine({
          text: "ok",
          sessionId: "a",
          uuid: "a1",
          requestId: "req-a1",
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 20,
        }),
        assistantLine({
          text: "more",
          sessionId: "a",
          uuid: "a2",
          requestId: "req-a2",
          inputTokens: 200,
          outputTokens: 75,
        })
      )
    );
    writeFileSync(
      path.join(logDir, "session-b.jsonl"),
      joinLines(
        assistantLine({
          text: "other",
          sessionId: "b",
          uuid: "b1",
          requestId: "req-b1",
          inputTokens: 50,
          outputTokens: 25,
        })
      )
    );

    const result = await computeDistillerUsageFromLog(logDir);

    // Sums across both files:
    //   in:  100 + 200 + 50  = 350
    //   out: 50  + 75  + 25  = 150
    //   cache_read: 20 (+ 0 + 0)
    expect(result).toEqual({
      in: 350,
      out: 150,
      cache_read: 20,
      cache_write: 0,
    });
  });

  it("returns null when the log dir does not exist", async () => {
    const result = await computeDistillerUsageFromLog(path.join(dir, "nonexistent"));
    expect(result).toBeNull();
  });

  it("returns null when the log dir contains no .jsonl files", async () => {
    const logDir = path.join(dir, "empty");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(path.join(logDir, "not-a-session.txt"), "hi");

    const result = await computeDistillerUsageFromLog(logDir);
    expect(result).toBeNull();
  });

  it("returns zero totals when the session has no assistant entries", async () => {
    const logDir = path.join(dir, "user-only");
    mkdirSync(logDir, { recursive: true });
    writeFileSync(
      path.join(logDir, "session.jsonl"),
      joinLines(userLine({ text: "alone", sessionId: "x" }))
    );

    const result = await computeDistillerUsageFromLog(logDir);
    expect(result).toEqual({ in: 0, out: 0, cache_read: 0, cache_write: 0 });
  });
});
