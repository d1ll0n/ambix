import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryToolUses } from "../../src/query/tool-uses.js";
import {
  cleanupTempDir,
  joinLines,
  makeTempDir,
  toolUseAssistantLine,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("queryToolUses", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  async function newSession(text: string): Promise<Session> {
    const p = writeFixture(dir, "session.jsonl", text);
    return new Session(p);
  }

  it("returns every tool_use block across assistant entries", async () => {
    const session = await newSession(
      joinLines(
        userLine({ text: "hi", uuid: "u1" }),
        toolUseAssistantLine({ name: "Read", input: { file_path: "a.ts" }, uuid: "a1" }),
        toolUseAssistantLine({
          name: "Write",
          input: { file_path: "b.ts", content: "x" },
          uuid: "a2",
        }),
        toolUseAssistantLine({ name: "Bash", input: { command: "ls" }, uuid: "a3" })
      )
    );

    const matches = await queryToolUses(session, {});
    expect(matches).toHaveLength(3);
    expect(matches.map((m) => m.ix)).toEqual([1, 2, 3]);
    expect(matches[0].summary).toContain("Read");
    expect(matches[1].summary).toContain("Write");
    expect(matches[2].summary).toContain("Bash");
  });

  it("filters by --name", async () => {
    const session = await newSession(
      joinLines(
        toolUseAssistantLine({ name: "Read", input: { file_path: "a.ts" }, uuid: "a1" }),
        toolUseAssistantLine({
          name: "Write",
          input: { file_path: "b.ts", content: "x" },
          uuid: "a2",
        }),
        toolUseAssistantLine({
          name: "Write",
          input: { file_path: "c.ts", content: "y" },
          uuid: "a3",
        })
      )
    );

    const matches = await queryToolUses(session, { name: "Write" });
    expect(matches).toHaveLength(2);
    expect(matches.every((m) => m.summary.includes("Write"))).toBe(true);
  });

  it("summary includes file_path for tool calls with it", async () => {
    const session = await newSession(
      joinLines(
        toolUseAssistantLine({
          name: "Edit",
          input: { file_path: "src/foo.ts", old_string: "x", new_string: "y" },
          uuid: "a1",
        })
      )
    );
    const matches = await queryToolUses(session, {});
    expect(matches[0].summary).toContain("src/foo.ts");
  });

  it("summary includes first line of command for Bash", async () => {
    const session = await newSession(
      joinLines(
        toolUseAssistantLine({
          name: "Bash",
          input: { command: "git log --oneline -n 5" },
          uuid: "a1",
        })
      )
    );
    const matches = await queryToolUses(session, {});
    expect(matches[0].summary).toContain("git log");
  });

  it("returns empty when no matches", async () => {
    const session = await newSession(joinLines(userLine({ text: "only user" })));
    expect(await queryToolUses(session, {})).toEqual([]);
  });
});
