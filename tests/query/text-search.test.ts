import { Session } from "parse-claude-logs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { queryTextSearch } from "../../src/query/text-search.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("queryTextSearch", () => {
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

  it("finds substring in assistant text blocks", async () => {
    const session = await newSession(
      joinLines(
        userLine({ text: "hi", uuid: "u1" }),
        assistantLine({ text: "I will use the Read tool now", uuid: "a1" }),
        assistantLine({ text: "nothing here", uuid: "a2" }),
        assistantLine({ text: "Read this carefully", uuid: "a3" })
      )
    );

    const matches = await queryTextSearch(session, { pattern: "Read" });
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.ix)).toEqual([1, 3]);
  });

  it("finds substring in user string content", async () => {
    const session = await newSession(
      joinLines(userLine({ text: "permission denied on this file", uuid: "u1" }))
    );

    const matches = await queryTextSearch(session, { pattern: "permission" });
    expect(matches).toHaveLength(1);
    expect(matches[0].ix).toBe(0);
  });

  it("filters by --role assistant", async () => {
    const session = await newSession(
      joinLines(
        userLine({ text: "find foo here", uuid: "u1" }),
        assistantLine({ text: "I found foo in the file", uuid: "a1" })
      )
    );

    const matches = await queryTextSearch(session, { pattern: "foo", role: "assistant" });
    expect(matches).toHaveLength(1);
    expect(matches[0].ix).toBe(1);
  });

  it("returns empty when no matches", async () => {
    const session = await newSession(joinLines(userLine({ text: "nothing to see", uuid: "u1" })));
    expect(await queryTextSearch(session, { pattern: "nomatch" })).toEqual([]);
  });
});
