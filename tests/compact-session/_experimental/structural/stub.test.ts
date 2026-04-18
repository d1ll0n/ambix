import type { ToolResultBlock } from "parse-cc";
import { describe, expect, it } from "vitest";
import {
  buildStub,
  measureToolResultBytes,
} from "../../../../src/compact-session/_experimental/structural/stub.js";

function result(content: unknown, isError = false): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: "toolu_x",
    content: content as ToolResultBlock["content"],
    is_error: isError,
  };
}

describe("buildStub", () => {
  it("produces a COMPACTION STUB marker with condenser summary and rehydration command", () => {
    const stub = buildStub({
      origSessionId: "abcd-1234",
      ix: 47,
      toolName: "Read",
      toolInput: { file_path: "/tmp/foo.ts" },
      originalResult: result("a".repeat(1000)),
    });

    expect(stub).toContain("[COMPACTION STUB");
    expect(stub).toContain("Read");
    expect(stub).toContain("foo.ts");
    expect(stub).toContain("1000 bytes removed");
    expect(stub).toContain("ambix query abcd-1234 47");
  });

  it("uses condenseGeneric for unknown tools", () => {
    const stub = buildStub({
      origSessionId: "s1",
      ix: 5,
      toolName: "mcp_custom__do_thing",
      toolInput: { key: "value" },
      originalResult: result("output body"),
    });

    expect(stub).toContain("mcp_custom__do_thing");
    expect(stub).toContain('key="value"');
    expect(stub).toContain("ambix query s1 5");
  });

  it("honors a custom ambixCmd override", () => {
    const stub = buildStub({
      origSessionId: "s1",
      ix: 3,
      toolName: "Bash",
      toolInput: { command: "ls" },
      originalResult: result("three\nlines\nhere"),
      ambixCmd: "/usr/bin/ambix query",
    });

    expect(stub).toContain("/usr/bin/ambix query s1 3");
  });

  it("reports 0 bytes removed when the original result is null", () => {
    const stub = buildStub({
      origSessionId: "s1",
      ix: 0,
      toolName: "Read",
      toolInput: { file_path: "/x" },
      originalResult: null,
    });

    expect(stub).toContain("0 bytes removed");
  });

  it("handles structured content arrays in tool_result", () => {
    const arrayContent = [
      { type: "text", text: "hello world" },
      { type: "text", text: "second chunk" },
    ];
    const stub = buildStub({
      origSessionId: "s1",
      ix: 10,
      toolName: "Bash",
      toolInput: { command: "echo" },
      originalResult: result(arrayContent),
    });

    // "hello world" (11) + "\n" (1) + "second chunk" (12) = 24 bytes
    expect(stub).toContain("24 bytes removed");
  });
});

describe("measureToolResultBytes", () => {
  it("returns 0 for null input", () => {
    expect(measureToolResultBytes(null)).toBe(0);
  });

  it("measures UTF-8 byte length, not char count", () => {
    // 3-byte UTF-8 character "€" + "!" = 4 bytes, not 2 chars
    expect(measureToolResultBytes(result("€!"))).toBe(4);
  });
});
