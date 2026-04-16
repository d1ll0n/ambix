import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFailures } from "../../src/analyze/failures.js";
import {
  cleanupTempDir,
  joinLines,
  makeTempDir,
  toolResultUserLine,
  toolUseAssistantLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("collectFailures", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("collects every is_error tool_result with the preceding tool_use input", async () => {
    const text = joinLines(
      toolUseAssistantLine({
        name: "Edit",
        input: { file_path: "x.ts", old_string: "not there", new_string: "y" },
        toolUseId: "toolu_1",
      }),
      toolResultUserLine({
        toolUseId: "toolu_1",
        content: "old_string not found",
        isError: true,
      }),
      toolUseAssistantLine({
        name: "Read",
        input: { file_path: "x.ts" },
        toolUseId: "toolu_2",
      }),
      toolResultUserLine({
        toolUseId: "toolu_2",
        content: [{ type: "text", text: "file content" }],
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const failures = collectFailures(entries);

    expect(failures).toHaveLength(1);
    expect(failures[0].tool).toBe("Edit");
    expect(failures[0].tool_use_id).toBe("toolu_1");
    expect(failures[0].error).toBe("old_string not found");
    expect((failures[0].input as { file_path: string }).file_path).toBe("x.ts");
  });

  it("handles failures whose content is a structured content block array", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Bash", input: { command: "false" }, toolUseId: "toolu_3" }),
      toolResultUserLine({
        toolUseId: "toolu_3",
        content: [{ type: "text", text: "exit 1" }],
        isError: true,
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const failures = collectFailures(entries);
    expect(failures).toHaveLength(1);
    expect(failures[0].tool).toBe("Bash");
    expect(failures[0].error).toContain("exit 1");
  });

  it("returns empty array when there are no is_error tool_results", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Read", input: { file_path: "a.ts" }, toolUseId: "t1" }),
      toolResultUserLine({ toolUseId: "t1", content: "ok" })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    expect(collectFailures(entries)).toEqual([]);
  });

  it("records ix of the tool_result (not the tool_use) since that's where the error is observed", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Edit", input: { file_path: "x" }, toolUseId: "t1" }),
      toolResultUserLine({ toolUseId: "t1", content: "err", isError: true })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const failures = collectFailures(entries);
    expect(failures[0].ix).toBe(1);
  });
});
