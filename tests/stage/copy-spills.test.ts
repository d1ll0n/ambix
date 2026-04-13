import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Session } from "parse-claude-logs";
import { collectAndCopySpills } from "../../src/stage/copy-spills.js";
import {
  makeTempDir,
  cleanupTempDir,
  writeFixture,
  joinLines,
} from "../helpers/fixtures.js";

describe("collectAndCopySpills", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("copies every persisted-output file referenced in tool_results into destDir", async () => {
    // Real spill file on disk
    const spillSrc = path.join(dir, "spill-source");
    mkdirSync(spillSrc, { recursive: true });
    const spillPath = path.join(spillSrc, "toolu_X.json");
    writeFileSync(spillPath, JSON.stringify([{ type: "text", text: "spill content" }]));

    // Session log referencing the spill
    const persistedWrapper = `<persisted-output>\nOutput too large (1.2KB). Full output saved to: ${spillPath}\n\nPreview (first 2KB):\nspill content\n`;
    const text = joinLines(
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "session-test",
        timestamp: "2026-04-13T10:00:00Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_X", content: persistedWrapper }],
        },
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const destDir = path.join(dir, "spill");
    const result = await collectAndCopySpills(entries, destDir);

    expect(result.copied).toBe(1);
    expect(existsSync(path.join(destDir, "toolu_X.json"))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(destDir, "toolu_X.json"), "utf8"))).toEqual([
      { type: "text", text: "spill content" },
    ]);
  });

  it("returns copied=0 and creates no directory when there are no spills", async () => {
    const text = joinLines(
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "session-test",
        timestamp: "2026-04-13T10:00:00Z",
        message: { role: "user", content: "no spills here" },
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const destDir = path.join(dir, "spill");
    const result = await collectAndCopySpills(entries, destDir);

    expect(result.copied).toBe(0);
    expect(existsSync(destDir)).toBe(false);
  });

  it("silently skips spills whose source file is missing", async () => {
    const persistedWrapper = `<persisted-output>\nOutput too large (1.2KB). Full output saved to: /nonexistent/path/missing.json\n\nPreview (first 2KB):\nx\n`;
    const text = joinLines(
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "session-test",
        timestamp: "2026-04-13T10:00:00Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_X", content: persistedWrapper }],
        },
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const destDir = path.join(dir, "spill");
    const result = await collectAndCopySpills(entries, destDir);

    expect(result.copied).toBe(0);
    expect(result.missing).toBe(1);
  });
});
