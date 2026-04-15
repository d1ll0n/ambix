import { Session } from "parse-claude-logs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryToolResults } from "../../src/query/tool-results.js";
import {
  cleanupTempDir,
  joinLines,
  makeTempDir,
  toolResultUserLine,
  toolUseAssistantLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("queryToolResults", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  async function newSession(text: string): Promise<Session> {
    return new Session(writeFixture(dir, "session.jsonl", text));
  }

  it("returns every tool_result block across user entries", async () => {
    const session = await newSession(
      joinLines(
        toolUseAssistantLine({
          name: "Read",
          input: { file_path: "a" },
          toolUseId: "t1",
          uuid: "a1",
        }),
        toolResultUserLine({ toolUseId: "t1", content: "ok" }),
        toolUseAssistantLine({
          name: "Write",
          input: { file_path: "b" },
          toolUseId: "t2",
          uuid: "a2",
        }),
        toolResultUserLine({ toolUseId: "t2", content: "wrote" })
      )
    );

    const matches = await queryToolResults(session, {});
    expect(matches).toHaveLength(2);
    expect(matches[0].summary).toContain("t1");
    expect(matches[1].summary).toContain("t2");
  });

  it("filters --error only", async () => {
    const session = await newSession(
      joinLines(
        toolUseAssistantLine({
          name: "Read",
          input: { file_path: "a" },
          toolUseId: "t1",
          uuid: "a1",
        }),
        toolResultUserLine({ toolUseId: "t1", content: "ok" }),
        toolUseAssistantLine({
          name: "Bash",
          input: { command: "false" },
          toolUseId: "t2",
          uuid: "a2",
        }),
        toolResultUserLine({ toolUseId: "t2", content: "failed", isError: true })
      )
    );

    const matches = await queryToolResults(session, { error: true });
    expect(matches).toHaveLength(1);
    expect(matches[0].summary).toContain("t2");
    expect(matches[0].summary.toLowerCase()).toContain("error");
  });

  it("filters --tool-use-id", async () => {
    const session = await newSession(
      joinLines(
        toolUseAssistantLine({
          name: "Read",
          input: { file_path: "a" },
          toolUseId: "t1",
          uuid: "a1",
        }),
        toolResultUserLine({ toolUseId: "t1", content: "ok" }),
        toolUseAssistantLine({
          name: "Bash",
          input: { command: "x" },
          toolUseId: "t2",
          uuid: "a2",
        }),
        toolResultUserLine({ toolUseId: "t2", content: "also ok" })
      )
    );

    const matches = await queryToolResults(session, { toolUseId: "t2" });
    expect(matches).toHaveLength(1);
    expect(matches[0].summary).toContain("t2");
  });
});
