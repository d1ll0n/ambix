import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderEntry } from "../../src/query/render-entry.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  toolResultUserLine,
  toolUseAssistantLine,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("renderEntry", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  async function first(text: string) {
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();
    return entries[0];
  }

  it("user entry with string content → plain text with [user] header", async () => {
    const e = await first(joinLines(userLine({ text: "hi there\nline 2" })));
    const out = renderEntry(e);
    expect(out).toContain("[user]");
    expect(out).toContain("hi there\nline 2");
    expect(out).not.toContain("parentUuid");
    expect(out).not.toContain("promptId");
  });

  it("assistant entry with text block → header + plain text, no JSON envelope", async () => {
    const e = await first(joinLines(assistantLine({ text: "hello world\nnext line" })));
    const out = renderEntry(e);
    expect(out).toMatch(/^\[assistant · /);
    expect(out).toContain("hello world\nnext line");
    expect(out).not.toContain("cache_read_input_tokens");
    expect(out).not.toContain("\\n");
  });

  it("assistant entry with tool_use block → tool_use line + pretty input", async () => {
    const e = await first(
      joinLines(
        toolUseAssistantLine({ name: "Read", input: { file_path: "/x.ts" }, toolUseId: "tu_A" })
      )
    );
    const out = renderEntry(e);
    expect(out).toContain("[tool_use: Read id=tu_A]");
    expect(out).toContain("/x.ts");
  });

  it("user tool_result entry → tool_use_id + flattened content with real newlines", async () => {
    const e = await first(
      joinLines(toolResultUserLine({ toolUseId: "tu_A", content: "line 1\nline 2" }))
    );
    const out = renderEntry(e);
    expect(out).toContain("[user · tool_result]");
    expect(out).toContain("tool_use_id: tu_A");
    expect(out).toContain("line 1\nline 2");
  });

  it("user tool_result with is_error=true → marks the error in the header body", async () => {
    const e = await first(
      joinLines(toolResultUserLine({ toolUseId: "tu_E", content: "boom", isError: true }))
    );
    const out = renderEntry(e);
    expect(out).toContain("is_error: true");
    expect(out).toContain("boom");
  });

  it("user tool_result with a <persisted-output> envelope → surface filePath, size, preview", async () => {
    const persistedText = [
      "<persisted-output>",
      "Output too large (2.3 MB). Full output saved to: /tmp/tr/tu_X.txt",
      "",
      "Preview (first 2000 chars):",
      "preview body",
      "with newlines",
      "</persisted-output>",
    ].join("\n");
    const e = await first(
      joinLines(toolResultUserLine({ toolUseId: "tu_X", content: persistedText }))
    );
    const out = renderEntry(e);
    expect(out).toContain("[spilled to /tmp/tr/tu_X.txt — 2.3 MB]");
    expect(out).toContain("preview body\nwith newlines");
    expect(out).not.toContain("<persisted-output");
  });

  it("user tool_result with structured content array → unwrap text entries", async () => {
    const text = JSON.stringify({
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId: "s",
      timestamp: "2026-04-17T10:00:00Z",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_S",
            content: [
              { type: "text", text: "part A" },
              { type: "text", text: "part B" },
            ],
            is_error: false,
          },
        ],
      },
    });
    const e = await first(`${text}\n`);
    const out = renderEntry(e);
    expect(out).toContain("part A");
    expect(out).toContain("part B");
  });
});
