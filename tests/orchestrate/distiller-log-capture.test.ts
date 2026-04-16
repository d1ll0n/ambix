import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  captureDistillerLog,
  waitForStability,
} from "../../src/orchestrate/distiller-log-capture.js";
import { cleanupTempDir, makeTempDir } from "../helpers/fixtures.js";

describe("captureDistillerLog", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("moves the distiller's session log files out of the fake cc-home into the output dir", async () => {
    // Fake CC home
    const ccHome = path.join(dir, "cc-home");
    // Fake tmp dir whose slugified form is the CC projects dir name
    const tmpDir = path.join(dir, "ambix-work", "sess-abc");
    // Slug replaces '/' with '-'
    const slug = tmpDir.replace(/\//g, "-");
    const ccProjectDir = path.join(ccHome, "projects", slug);

    mkdirSync(ccProjectDir, { recursive: true });
    // Simulate a distiller session log
    writeFileSync(path.join(ccProjectDir, "session-uuid-1.jsonl"), '{"type":"user","x":1}\n');
    writeFileSync(path.join(ccProjectDir, "session-uuid-2.jsonl"), '{"type":"user","x":2}\n');
    // Simulate a subagents subdir
    mkdirSync(path.join(ccProjectDir, "session-uuid-1", "subagents"), { recursive: true });
    writeFileSync(
      path.join(ccProjectDir, "session-uuid-1", "subagents", "agent-foo.jsonl"),
      '{"sub":true}\n'
    );

    const outputRoot = path.join(dir, "ambix-home");

    const result = await captureDistillerLog({
      tmpDir,
      sessionId: "source-sess-1",
      outputRoot,
      ccHome,
      stabilityPollIntervalMs: 10,
      stabilityTimeoutMs: 100,
    });

    // Files moved to <outputRoot>/sessions/source-sess-1/distiller-log/
    const destDir = path.join(outputRoot, "sessions", "source-sess-1", "distiller-log");
    expect(result.destDir).toBe(destDir);
    expect(result.filesCaptured).toBe(2);
    expect(existsSync(path.join(destDir, "session-uuid-1.jsonl"))).toBe(true);
    expect(existsSync(path.join(destDir, "session-uuid-2.jsonl"))).toBe(true);
    // Subagents subdir carried over
    expect(existsSync(path.join(destDir, "session-uuid-1", "subagents", "agent-foo.jsonl"))).toBe(
      true
    );
    // Source project dir removed
    expect(existsSync(ccProjectDir)).toBe(false);
  });

  it("returns filesCaptured=0 and does nothing when the source project dir does not exist", async () => {
    const ccHome = path.join(dir, "cc-home");
    const tmpDir = path.join(dir, "nonexistent-work");
    const outputRoot = path.join(dir, "ambix-home");

    const result = await captureDistillerLog({
      tmpDir,
      sessionId: "sess",
      outputRoot,
      ccHome,
    });

    expect(result.filesCaptured).toBe(0);
    expect(existsSync(path.join(outputRoot, "sessions", "sess", "distiller-log"))).toBe(false);
  });
});

describe("waitForStability", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("waitForStability returns quickly when the dir is stable", async () => {
    const subdir = path.join(dir, "project");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(path.join(subdir, "a.jsonl"), "a");
    writeFileSync(path.join(subdir, "b.jsonl"), "bb");

    const start = Date.now();
    await waitForStability(subdir, { pollIntervalMs: 10, timeoutMs: 500, stableObservations: 2 });
    const elapsed = Date.now() - start;

    // Should return within ~30ms: 2 observations × 10ms
    expect(elapsed).toBeLessThan(200);
  });

  it("waitForStability waits for writes to stop", async () => {
    const subdir = path.join(dir, "project");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(path.join(subdir, "a.jsonl"), "a");

    // Schedule a write to happen 15ms in — well within the first 20ms poll
    // interval so the new file is visible on the second poll (t≈20ms), which
    // resets the stable counter and forces two more polls before returning.
    // Track the handle so we can clear it if stability resolves unexpectedly
    // early (avoids a dangling write into a cleaned-up temp dir).
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      timer = setTimeout(() => {
        writeFileSync(path.join(subdir, "b.jsonl"), "delayed");
      }, 15);

      const start = Date.now();
      await waitForStability(subdir, {
        pollIntervalMs: 20,
        timeoutMs: 2000,
        stableObservations: 2,
      });
      const elapsed = Date.now() - start;

      // The write at 15ms resets stability; we need two more polls (~40ms more),
      // so total elapsed should be well above 15ms.
      expect(elapsed).toBeGreaterThan(15);
      // Both files should be present
      expect(existsSync(path.join(subdir, "a.jsonl"))).toBe(true);
      expect(existsSync(path.join(subdir, "b.jsonl"))).toBe(true);
    } finally {
      clearTimeout(timer);
    }
  });

  it("waitForStability gives up after timeoutMs", async () => {
    const subdir = path.join(dir, "project");
    mkdirSync(subdir, { recursive: true });
    writeFileSync(path.join(subdir, "a.jsonl"), "a");

    // Keep churning the dir so it never stabilizes.
    // Write monotonically-growing content so the file size strictly increases
    // on each write, guaranteeing the signature changes every poll.
    let churn = true;
    (async () => {
      let n = 0;
      let content = "";
      while (churn) {
        content += `${n++}\n`; // grows each iteration — size never repeats
        try {
          writeFileSync(path.join(subdir, "churn.jsonl"), content);
        } catch {}
        await new Promise((r) => setTimeout(r, 10));
      }
    })();

    try {
      const start = Date.now();
      await waitForStability(subdir, { pollIntervalMs: 20, timeoutMs: 200, stableObservations: 3 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeGreaterThanOrEqual(200);
      expect(elapsed).toBeLessThan(600); // doesn't hang indefinitely
    } finally {
      churn = false;
    }
  });
});
