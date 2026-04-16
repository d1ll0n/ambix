import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectAndCopySpills } from "../../src/stage/copy-spills.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  userLine,
  writeFixture,
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

    const destDir = path.join(dir, "spill");
    const result = await collectAndCopySpills(session, destDir);

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

    const destDir = path.join(dir, "spill");
    const result = await collectAndCopySpills(session, destDir);

    expect(result.copied).toBe(0);
    expect(existsSync(destDir)).toBe(false);
  });

  it("silently skips spills whose source file is missing", async () => {
    const persistedWrapper =
      "<persisted-output>\nOutput too large (1.2KB). Full output saved to: /nonexistent/path/missing.json\n\nPreview (first 2KB):\nx\n";
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

    const destDir = path.join(dir, "spill");
    const result = await collectAndCopySpills(session, destDir);

    expect(result.copied).toBe(0);
    expect(result.missing).toBe(1);
  });

  it("copies spill files referenced only by a subagent (not the parent)", async () => {
    // Real spill files on disk
    const spillSrc = path.join(dir, "spill-source");
    mkdirSync(spillSrc, { recursive: true });
    const parentSpillPath = path.join(spillSrc, "parent.txt");
    const subSpillPath = path.join(spillSrc, "sub.txt");
    writeFileSync(parentSpillPath, "parent spill content");
    writeFileSync(subSpillPath, "sub spill content");

    // Set up new-layout structure:
    // <project>/<parent-uuid>.jsonl is the parent
    // <project>/<parent-uuid>/subagents/agent-<uuid>.jsonl is the subagent
    const project = path.join(dir, "project");
    mkdirSync(project, { recursive: true });
    const parentUuid = "11111111-1111-1111-1111-111111111111";
    const parentPath = path.join(project, `${parentUuid}.jsonl`);

    // Parent references parent spill
    const parentWrapper = `<persisted-output>\nOutput too large (1KB). Full output saved to: ${parentSpillPath}\n\nPreview (first 2KB):\nparent\n`;
    writeFileSync(
      parentPath,
      joinLines(
        userLine({ text: "hi", sessionId: parentUuid, uuid: "p1" }),
        assistantLine({ text: "ok", sessionId: parentUuid, uuid: "p2", parentUuid: "p1" }),
        JSON.stringify({
          type: "user",
          uuid: "p3",
          parentUuid: "p2",
          sessionId: parentUuid,
          timestamp: "2026-04-13T10:00:00Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_parent", content: parentWrapper }],
          },
        })
      )
    );

    // Subagent references sub spill
    const subDir = path.join(project, parentUuid, "subagents");
    mkdirSync(subDir, { recursive: true });
    const agentUuid = "22222222-2222-2222-2222-222222222222";
    const subWrapper = `<persisted-output>\nOutput too large (1KB). Full output saved to: ${subSpillPath}\n\nPreview (first 2KB):\nsub\n`;
    writeFileSync(
      path.join(subDir, `agent-${agentUuid}.jsonl`),
      joinLines(
        userLine({ text: "task", sessionId: agentUuid, uuid: "s1" }),
        assistantLine({ text: "done", sessionId: agentUuid, uuid: "s2", parentUuid: "s1" }),
        JSON.stringify({
          type: "user",
          uuid: "s3",
          parentUuid: "s2",
          sessionId: agentUuid,
          timestamp: "2026-04-13T10:00:10Z",
          message: {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: subWrapper }],
          },
        })
      )
    );

    const session = new Session(parentPath);
    const destDir = path.join(dir, "spill");
    const result = await collectAndCopySpills(session, destDir);

    // Both parent and subagent spills should be copied
    expect(result.copied).toBe(2);
    expect(existsSync(path.join(destDir, "parent.txt"))).toBe(true);
    expect(existsSync(path.join(destDir, "sub.txt"))).toBe(true);
    expect(readFileSync(path.join(destDir, "parent.txt"), "utf8")).toBe("parent spill content");
    expect(readFileSync(path.join(destDir, "sub.txt"), "utf8")).toBe("sub spill content");
  });
});
