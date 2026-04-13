import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Session } from "parse-claude-logs";
import { condenseEntries } from "../../src/stage/condense.js";
import {
  makeTempDir,
  cleanupTempDir,
  writeFixture,
  joinLines,
  userLine,
  assistantLine,
} from "../helpers/fixtures.js";

describe("condenseEntries — basic", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("assigns sequential ix values starting at 0", async () => {
    const text = joinLines(
      userLine({ text: "first", uuid: "u1" }),
      assistantLine({ text: "second", uuid: "a1", parentUuid: "u1" })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });

    expect(result).toHaveLength(2);
    expect(result[0].ix).toBe(0);
    expect(result[1].ix).toBe(1);
  });

  it("preserves uuid in ref field", async () => {
    const text = joinLines(userLine({ text: "x", uuid: "abc-123" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].ref).toBe("uuid:abc-123");
  });

  it("computes parent_ix from parentUuid linkage", async () => {
    const text = joinLines(
      userLine({ text: "first", uuid: "u1", parentUuid: null }),
      assistantLine({ text: "reply", uuid: "a1", parentUuid: "u1" })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].parent_ix).toBe(null);
    expect(result[1].parent_ix).toBe(0);
  });

  it("includes assistant token usage", async () => {
    const text = joinLines(
      assistantLine({ text: "x", inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].tokens).toEqual({ in: 100, out: 50, cache_read: 20 });
  });

  it("flags synthetic-model assistant entries", async () => {
    const text = joinLines(
      assistantLine({ text: "synthetic", model: "<synthetic>" })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].synthetic).toBe(true);
  });

  it("preserves content unchanged when below truncation threshold", async () => {
    const text = joinLines(userLine({ text: "small content" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].content).toBe("small content");
  });
});
