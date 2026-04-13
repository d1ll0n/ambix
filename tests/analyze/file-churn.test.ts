import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Session } from "parse-claude-logs";
import { buildFileChurnTimeline } from "../../src/analyze/file-churn.js";
import {
  makeTempDir,
  cleanupTempDir,
  writeFixture,
  joinLines,
  userLine,
  toolUseAssistantLine,
} from "../helpers/fixtures.js";

describe("buildFileChurnTimeline", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("records ordered events per file grouped by path", async () => {
    const text = joinLines(
      userLine({ text: "hi" }),
      toolUseAssistantLine({ name: "Read", input: { file_path: "a.ts" } }),
      toolUseAssistantLine({ name: "Read", input: { file_path: "b.ts" } }),
      toolUseAssistantLine({ name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } }),
      toolUseAssistantLine({ name: "Read", input: { file_path: "a.ts" } })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const timeline = buildFileChurnTimeline(entries);

    const a = timeline.find((t) => t.path === "a.ts")!;
    expect(a.events.map((e) => e.kind)).toEqual(["read", "edit", "read"]);
    expect(a.events[0].ix).toBeLessThan(a.events[1].ix);
    expect(a.events[1].ix).toBeLessThan(a.events[2].ix);

    const b = timeline.find((t) => t.path === "b.ts")!;
    expect(b.events).toHaveLength(1);
    expect(b.events[0].kind).toBe("read");
  });

  it("returns an empty array when no file-affecting tools were used", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Bash", input: { command: "ls" } })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    expect(buildFileChurnTimeline(entries)).toEqual([]);
  });

  it("classifies Write as 'write', Edit and MultiEdit as 'edit', Read as 'read'", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Write", input: { file_path: "f.ts", content: "x" } }),
      toolUseAssistantLine({ name: "Edit", input: { file_path: "f.ts", old_string: "x", new_string: "y" } }),
      toolUseAssistantLine({ name: "MultiEdit", input: { file_path: "f.ts", edits: [] } }),
      toolUseAssistantLine({ name: "Read", input: { file_path: "f.ts" } })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const timeline = buildFileChurnTimeline(entries);
    const f = timeline.find((t) => t.path === "f.ts")!;
    expect(f.events.map((e) => e.kind)).toEqual(["write", "edit", "edit", "read"]);
  });
});
