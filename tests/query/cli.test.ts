import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { runQuery } from "../../src/query/index.js";
import {
  makeTempDir,
  cleanupTempDir,
  writeFixture,
  joinLines,
  userLine,
  toolUseAssistantLine,
} from "../helpers/fixtures.js";

describe("runQuery dispatcher", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("routes to tool-uses subcommand", async () => {
    const p = writeFixture(
      dir,
      "session.jsonl",
      joinLines(
        toolUseAssistantLine({ name: "Write", input: { file_path: "x" }, uuid: "a1" })
      )
    );
    const { code, output } = await runQuery([p, "tool-uses"]);
    expect(code).toBe(0);
    expect(output).toContain("Write");
  });

  it("routes to show subcommand with --field", async () => {
    const p = writeFixture(
      dir,
      "session.jsonl",
      joinLines(
        toolUseAssistantLine({ name: "Write", input: { file_path: "foo.md", content: "payload" }, uuid: "a1" })
      )
    );
    const { code, output } = await runQuery([p, "show", "0", "--field", "message.content[0].input.content"]);
    expect(code).toBe(0);
    expect(output.trim()).toBe("payload");
  });

  it("--help returns 0 and prints usage (even with no session arg)", async () => {
    const { code, output } = await runQuery(["--help"]);
    expect(code).toBe(0);
    expect(output).toContain("usage:");
    expect(output).toContain("tool-uses");
  });

  it("returns non-zero for unknown subcommand", async () => {
    const p = writeFixture(dir, "session.jsonl", joinLines(userLine({ text: "x" })));
    const { code, output } = await runQuery([p, "bogus"]);
    expect(code).toBe(1);
    expect(output).toContain("unknown query subcommand");
  });

  it("--count format prints just the number", async () => {
    const p = writeFixture(
      dir,
      "session.jsonl",
      joinLines(
        toolUseAssistantLine({ name: "Write", input: { file_path: "x" }, uuid: "a1" }),
        toolUseAssistantLine({ name: "Write", input: { file_path: "y" }, uuid: "a2" })
      )
    );
    const { code, output } = await runQuery([p, "tool-uses", "--count"]);
    expect(code).toBe(0);
    expect(output.trim()).toBe("2");
  });
});
