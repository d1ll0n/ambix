import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { crossReferenceSubagents } from "../../src/analyze/subagents.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  toolUseAssistantLine,
  userLine,
} from "../helpers/fixtures.js";

describe("crossReferenceSubagents", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("matches parent Task tool_use blocks to subagent sessions by ordinal", async () => {
    const project = path.join(dir, "project");
    mkdirSync(project, { recursive: true });
    const parentUuid = "11111111-1111-1111-1111-111111111111";
    const parentPath = path.join(project, `${parentUuid}.jsonl`);
    writeFileSync(
      parentPath,
      joinLines(
        userLine({ text: "go", sessionId: parentUuid }),
        toolUseAssistantLine({
          name: "Task",
          input: { subagent_type: "general-purpose", prompt: "do the thing" },
          sessionId: parentUuid,
          ts: "2026-04-13T10:00:00Z",
        })
      )
    );

    const subDir = path.join(project, parentUuid, "subagents");
    mkdirSync(subDir, { recursive: true });
    const agentUuid = "22222222-2222-2222-2222-222222222222";
    writeFileSync(
      path.join(subDir, `agent-${agentUuid}.jsonl`),
      joinLines(
        userLine({ text: "do the thing", sessionId: agentUuid, ts: "2026-04-13T10:00:01Z" }),
        assistantLine({
          text: "done",
          sessionId: agentUuid,
          ts: "2026-04-13T10:00:02Z",
          inputTokens: 50,
          outputTokens: 25,
        })
      )
    );

    const session = new Session(parentPath);
    const records = await crossReferenceSubagents(session);

    expect(records).toHaveLength(1);
    expect(records[0].agent_id).toBe(agentUuid);
    expect(records[0].subagent_type).toBe("general-purpose");
    expect(records[0].parent_ix).not.toBeNull();
    expect(records[0].tokens.in).toBe(50);
    expect(records[0].tokens.out).toBe(25);
    expect(records[0].turn_count).toBe(2);
  });

  it("returns empty array when the session has no subagents", async () => {
    const project = path.join(dir, "project");
    mkdirSync(project, { recursive: true });
    const parentPath = path.join(project, "solo.jsonl");
    writeFileSync(parentPath, joinLines(userLine({ text: "alone" })));

    const session = new Session(parentPath);
    const records = await crossReferenceSubagents(session);
    expect(records).toEqual([]);
  });

  it("records parent_ix: null for subagents that can't be ordinal-matched", async () => {
    const project = path.join(dir, "project");
    mkdirSync(project, { recursive: true });
    const parentUuid = "11111111-1111-1111-1111-111111111111";
    const parentPath = path.join(project, `${parentUuid}.jsonl`);
    writeFileSync(parentPath, joinLines(userLine({ text: "go", sessionId: parentUuid })));

    const subDir = path.join(project, parentUuid, "subagents");
    mkdirSync(subDir, { recursive: true });
    const agentUuid = "22222222-2222-2222-2222-222222222222";
    writeFileSync(
      path.join(subDir, `agent-${agentUuid}.jsonl`),
      joinLines(userLine({ text: "do", sessionId: agentUuid }))
    );

    const session = new Session(parentPath);
    const records = await crossReferenceSubagents(session);
    expect(records).toHaveLength(1);
    expect(records[0].parent_ix).toBeNull();
  });
});
