import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Session } from "parse-claude-logs";
import { aggregateToolUse } from "../../src/analyze/tool-aggregates.js";
import {
  makeTempDir,
  cleanupTempDir,
  writeFixture,
  joinLines,
  userLine,
  toolUseAssistantLine,
} from "../helpers/fixtures.js";

describe("aggregateToolUse", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("counts invocations per tool name", async () => {
    const text = joinLines(
      userLine({ text: "hi" }),
      toolUseAssistantLine({ name: "Read", input: { file_path: "a.ts" } }),
      toolUseAssistantLine({ name: "Read", input: { file_path: "b.ts" } }),
      toolUseAssistantLine({ name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } }),
      toolUseAssistantLine({ name: "Bash", input: { command: "ls" } })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = aggregateToolUse(entries);

    expect(result.tools.invocations).toEqual({ Read: 2, Edit: 1, Bash: 1 });
  });

  it("computes per-file R/W/E counts from Read/Edit/Write/MultiEdit tool_use inputs", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Read", input: { file_path: "src/a.ts" } }),
      toolUseAssistantLine({ name: "Read", input: { file_path: "src/a.ts" } }),
      toolUseAssistantLine({ name: "Edit", input: { file_path: "src/a.ts", old_string: "x", new_string: "y" } }),
      toolUseAssistantLine({ name: "Write", input: { file_path: "src/b.ts", content: "hi" } }),
      toolUseAssistantLine({
        name: "MultiEdit",
        input: { file_path: "src/c.ts", edits: [{ old_string: "x", new_string: "y" }] },
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = aggregateToolUse(entries);

    const a = result.files.touched.find((f) => f.path === "src/a.ts")!;
    expect(a).toEqual({ path: "src/a.ts", reads: 2, edits: 1, writes: 0 });
    const b = result.files.touched.find((f) => f.path === "src/b.ts")!;
    expect(b).toEqual({ path: "src/b.ts", reads: 0, edits: 0, writes: 1 });
    const c = result.files.touched.find((f) => f.path === "src/c.ts")!;
    expect(c).toEqual({ path: "src/c.ts", reads: 0, edits: 1, writes: 0 });
  });

  it("lists files that were read but never edited or written as read_without_write", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Read", input: { file_path: "src/read-only.ts" } }),
      toolUseAssistantLine({ name: "Read", input: { file_path: "src/modified.ts" } }),
      toolUseAssistantLine({
        name: "Edit",
        input: { file_path: "src/modified.ts", old_string: "x", new_string: "y" },
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = aggregateToolUse(entries);

    expect(result.files.read_without_write).toEqual(["src/read-only.ts"]);
  });

  it("ignores tool_use blocks that lack a file_path input", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Bash", input: { command: "ls" } }),
      toolUseAssistantLine({ name: "Grep", input: { pattern: "foo" } })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = aggregateToolUse(entries);
    expect(result.files.touched).toEqual([]);
    expect(result.tools.invocations).toEqual({ Bash: 1, Grep: 1 });
  });
});
