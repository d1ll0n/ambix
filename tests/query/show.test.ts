import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Session } from "parse-claude-logs";
import { queryShow } from "../../src/query/show.js";
import {
  makeTempDir,
  cleanupTempDir,
  writeFixture,
  joinLines,
  userLine,
  toolUseAssistantLine,
} from "../helpers/fixtures.js";

describe("queryShow", () => {
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

  it("returns the full entry at ix when no field given", async () => {
    const session = await newSession(
      joinLines(
        userLine({ text: "hi", uuid: "u1" }),
        toolUseAssistantLine({
          name: "Write",
          input: { file_path: "foo.md", content: "hello world" },
          toolUseId: "t1",
          uuid: "a1",
        })
      )
    );

    const result = await queryShow(session, { ix: 1 });
    expect(result).not.toBeNull();
    expect((result as { type: string }).type).toBe("assistant");
  });

  it("extracts a specific field via --field", async () => {
    const session = await newSession(
      joinLines(
        toolUseAssistantLine({
          name: "Write",
          input: { file_path: "foo.md", content: "hello world" },
          toolUseId: "t1",
          uuid: "a1",
        })
      )
    );

    const result = await queryShow(session, {
      ix: 0,
      field: "message.content[0].input.content",
    });
    expect(result).toBe("hello world");
  });

  it("throws for out-of-range ix", async () => {
    const session = await newSession(joinLines(userLine({ text: "one" })));
    await expect(queryShow(session, { ix: 99 })).rejects.toThrow(/ix.*99/);
  });

  it("returns undefined from getFieldByPath for a missing field path", async () => {
    const session = await newSession(joinLines(userLine({ text: "hi", uuid: "u1" })));
    const result = await queryShow(session, { ix: 0, field: "not.a.real.path" });
    expect(result).toBeUndefined();
  });
});
