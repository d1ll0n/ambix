import { describe, expect, it } from "vitest";
import {
  globToRegex,
  matchesToolSelector,
  matchesTypeSelector,
  parseSelector,
  splitByKind,
} from "../../src/compact-session/preserve-selector.js";

describe("globToRegex", () => {
  it("* matches any sequence", () => {
    expect(globToRegex("mcp__*").test("mcp__telegram__send")).toBe(true);
    expect(globToRegex("mcp__*").test("mcp__")).toBe(true);
    expect(globToRegex("mcp__*").test("other")).toBe(false);
  });

  it("? matches exactly one character", () => {
    expect(globToRegex("a?c").test("abc")).toBe(true);
    expect(globToRegex("a?c").test("ac")).toBe(false);
    expect(globToRegex("a?c").test("abbc")).toBe(false);
  });

  it("escapes regex metacharacters in literal text", () => {
    // A pattern like "Grep+" should match literal "Grep+", not "Grep" or "Grepp".
    const re = globToRegex("file.ext");
    expect(re.test("file.ext")).toBe(true);
    expect(re.test("fileAext")).toBe(false); // `.` is literal, not regex-dot
  });

  it("is anchored — no partial matches", () => {
    expect(globToRegex("foo").test("foobar")).toBe(false);
    expect(globToRegex("foo").test("barfoo")).toBe(false);
    expect(globToRegex("foo").test("foo")).toBe(true);
  });

  it("is case-sensitive", () => {
    expect(globToRegex("Bash").test("bash")).toBe(false);
    expect(globToRegex("Bash").test("Bash")).toBe(true);
  });
});

describe("parseSelector", () => {
  it("parses a tool selector", () => {
    const s = parseSelector("tool:mcp__*");
    expect(s.kind).toBe("tool");
    expect(s.pattern.test("mcp__telegram__send")).toBe(true);
    expect(s.pattern.test("Bash")).toBe(false);
  });

  it("parses a type selector", () => {
    const s = parseSelector("type:file-history-snapshot");
    expect(s.kind).toBe("type");
    expect(s.pattern.test("file-history-snapshot")).toBe(true);
    expect(s.pattern.test("system")).toBe(false);
  });

  it("allows colons inside the pattern (only the first split counts)", () => {
    // Hypothetical tool name with a colon. Splits on first `:` only, so
    // `tool:ns:X` means kind="tool", pattern="ns:X".
    const s = parseSelector("tool:ns:X");
    expect(s.kind).toBe("tool");
    expect(s.pattern.test("ns:X")).toBe(true);
  });

  it("rejects missing colon", () => {
    expect(() => parseSelector("mcp__telegram")).toThrowError(/<kind>:<pattern>/);
  });

  it("rejects unknown kind", () => {
    expect(() => parseSelector("role:user")).toThrowError(/unknown kind/);
  });

  it("rejects empty pattern", () => {
    expect(() => parseSelector("tool:")).toThrowError(/pattern must be non-empty/);
  });

  it("rejects leading colon", () => {
    expect(() => parseSelector(":foo")).toThrowError(/<kind>:<pattern>/);
  });
});

describe("matchesToolSelector / matchesTypeSelector", () => {
  it("matchesToolSelector only considers tool selectors", () => {
    const selectors = [parseSelector("tool:mcp__*"), parseSelector("type:system")];
    expect(matchesToolSelector("mcp__telegram__send", selectors)).toBe(true);
    // A type: selector must NOT match a tool-name check, even if the strings align.
    expect(matchesToolSelector("system", selectors)).toBe(false);
  });

  it("matchesTypeSelector only considers type selectors", () => {
    const selectors = [parseSelector("tool:mcp__*"), parseSelector("type:system")];
    expect(matchesTypeSelector("system", selectors)).toBe(true);
    // A tool: selector must NOT match a type-name check.
    expect(matchesTypeSelector("mcp__telegram__send", selectors)).toBe(false);
  });

  it("returns false when no selectors match", () => {
    const selectors = [parseSelector("tool:mcp__*")];
    expect(matchesToolSelector("Bash", selectors)).toBe(false);
    expect(matchesTypeSelector("user", selectors)).toBe(false);
  });

  it("returns false when given an empty selector list", () => {
    expect(matchesToolSelector("anything", [])).toBe(false);
    expect(matchesTypeSelector("anything", [])).toBe(false);
  });
});

describe("splitByKind", () => {
  it("partitions selectors by kind", () => {
    const selectors = [
      parseSelector("tool:mcp__*"),
      parseSelector("type:system"),
      parseSelector("tool:Bash"),
    ];
    const { tool, type } = splitByKind(selectors);
    expect(tool).toHaveLength(2);
    expect(type).toHaveLength(1);
    expect(tool.every((s) => s.kind === "tool")).toBe(true);
    expect(type.every((s) => s.kind === "type")).toBe(true);
  });

  it("returns empty arrays when no selectors of a kind are present", () => {
    const selectors = [parseSelector("tool:Bash")];
    const { tool, type } = splitByKind(selectors);
    expect(tool).toHaveLength(1);
    expect(type).toHaveLength(0);
  });
});
