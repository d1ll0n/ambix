import { describe, it, expect } from "vitest";
import { formatMatches, getFieldByPath } from "../../src/query/format.js";
import type { QueryMatch } from "../../src/query/types.js";

describe("formatMatches", () => {
  const matches: QueryMatch[] = [
    { ix: 5, kind: "tool_use", summary: "Write file_path=foo.md (12 lines)" },
    { ix: 12, kind: "tool_use", summary: "Write file_path=bar.md (3 lines)" },
  ];

  it("compact format prints one line per match", () => {
    const out = formatMatches(matches, "compact");
    const lines = out.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("5");
    expect(lines[0]).toContain("Write");
    expect(lines[0]).toContain("foo.md");
  });

  it("count format prints just the number", () => {
    expect(formatMatches(matches, "count").trim()).toBe("2");
  });

  it("full format prints one JSON object per line", () => {
    const withRaw: QueryMatch[] = [
      { ix: 5, kind: "tool_use", summary: "x", raw: { input: { file_path: "foo.md" } } },
    ];
    const out = formatMatches(withRaw, "full");
    const parsed = JSON.parse(out.trim());
    expect(parsed.ix).toBe(5);
    expect(parsed.raw.input.file_path).toBe("foo.md");
  });

  it("handles an empty match array for every format", () => {
    expect(formatMatches([], "compact")).toBe("");
    expect(formatMatches([], "count").trim()).toBe("0");
    expect(formatMatches([], "full")).toBe("");
  });
});

describe("getFieldByPath", () => {
  const obj = {
    content: [
      { type: "text", text: "hello" },
      { type: "tool_use", input: { file_path: "foo.md", content: "bar" } },
    ],
    usage: { input_tokens: 100 },
  };

  it("reads a top-level key", () => {
    expect(getFieldByPath(obj, "usage")).toEqual({ input_tokens: 100 });
  });

  it("reads a nested object field via dot path", () => {
    expect(getFieldByPath(obj, "usage.input_tokens")).toBe(100);
  });

  it("reads an array element via [N] index", () => {
    expect(getFieldByPath(obj, "content[0].text")).toBe("hello");
    expect(getFieldByPath(obj, "content[1].input.file_path")).toBe("foo.md");
  });

  it("returns undefined for a missing path", () => {
    expect(getFieldByPath(obj, "nothing.here")).toBeUndefined();
    expect(getFieldByPath(obj, "content[99].type")).toBeUndefined();
  });
});
