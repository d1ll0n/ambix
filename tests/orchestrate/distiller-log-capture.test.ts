import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { captureDistillerLog } from "../../src/orchestrate/distiller-log-capture.js";
import { makeTempDir, cleanupTempDir } from "../helpers/fixtures.js";

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
    const tmpDir = path.join(dir, "alembic-work", "sess-abc");
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

    const outputRoot = path.join(dir, "alembic-home");

    const result = await captureDistillerLog({
      tmpDir,
      sessionId: "source-sess-1",
      outputRoot,
      ccHome,
    });

    // Files moved to <outputRoot>/sessions/source-sess-1/distiller-log/
    const destDir = path.join(outputRoot, "sessions", "source-sess-1", "distiller-log");
    expect(result.destDir).toBe(destDir);
    expect(result.filesCaptured).toBe(2);
    expect(existsSync(path.join(destDir, "session-uuid-1.jsonl"))).toBe(true);
    expect(existsSync(path.join(destDir, "session-uuid-2.jsonl"))).toBe(true);
    // Subagents subdir carried over
    expect(existsSync(path.join(destDir, "session-uuid-1", "subagents", "agent-foo.jsonl"))).toBe(true);
    // Source project dir removed
    expect(existsSync(ccProjectDir)).toBe(false);
  });

  it("returns filesCaptured=0 and does nothing when the source project dir does not exist", async () => {
    const ccHome = path.join(dir, "cc-home");
    const tmpDir = path.join(dir, "nonexistent-work");
    const outputRoot = path.join(dir, "alembic-home");

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
