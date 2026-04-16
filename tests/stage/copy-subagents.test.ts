import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageSubagents } from "../../src/stage/copy-subagents.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  userLine,
} from "../helpers/fixtures.js";

describe("stageSubagents", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("stages each subagent into its own subdirectory with a session.jsonl", async () => {
    // Set up new-layout structure: parent at <project>/<parent-uuid>.jsonl,
    // subagents at <project>/<parent-uuid>/subagents/agent-*.jsonl
    const project = path.join(dir, "project");
    mkdirSync(project, { recursive: true });
    const parentUuid = "11111111-1111-1111-1111-111111111111";
    const parentPath = path.join(project, `${parentUuid}.jsonl`);
    writeFileSync(
      parentPath,
      joinLines(
        userLine({ text: "do a thing", uuid: "p1", sessionId: parentUuid }),
        assistantLine({ text: "ok", uuid: "p2", sessionId: parentUuid })
      )
    );

    const subDir = path.join(project, parentUuid, "subagents");
    mkdirSync(subDir, { recursive: true });
    const agentUuid = "22222222-2222-2222-2222-222222222222";
    writeFileSync(
      path.join(subDir, `agent-${agentUuid}.jsonl`),
      joinLines(
        userLine({ text: "subagent task", uuid: "s1", sessionId: agentUuid }),
        assistantLine({ text: "subagent result", uuid: "s2", sessionId: agentUuid })
      )
    );

    const session = new Session(parentPath);
    await session.messages();

    const destDir = path.join(dir, "subagents");
    const result = await stageSubagents(session, destDir);

    expect(result.staged).toBe(1);
    const stagedDir = path.join(destDir, `agent-${agentUuid}`);
    expect(existsSync(path.join(stagedDir, "session.jsonl"))).toBe(true);

    // Each subagent's session.jsonl should be condensed JSONL (one JSON per line, with ix)
    const lines = readFileSync(path.join(stagedDir, "session.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines.length).toBeGreaterThan(0);
    const first = JSON.parse(lines[0]);
    expect(first).toHaveProperty("ix");
    expect(first).toHaveProperty("ref");
  });

  it("returns staged=0 and creates nothing when there are no subagents", async () => {
    const project = path.join(dir, "project");
    mkdirSync(project, { recursive: true });
    const parentPath = path.join(project, "loner.jsonl");
    writeFileSync(parentPath, joinLines(userLine({ text: "alone" })));

    const session = new Session(parentPath);
    await session.messages();

    const destDir = path.join(dir, "subagents");
    const result = await stageSubagents(session, destDir);

    expect(result.staged).toBe(0);
    expect(existsSync(destDir)).toBe(false);
  });
});
