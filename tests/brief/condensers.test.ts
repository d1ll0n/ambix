import type { ToolResultBlock } from "parse-cc";
import { describe, expect, it } from "vitest";
import {
  condenseToolUse,
  diffStat,
  extractCommit,
  fmtPath,
  shorten,
} from "../../src/brief/condensers.js";

function result(content: unknown, isError = false): ToolResultBlock {
  return {
    type: "tool_result",
    tool_use_id: "toolu_x",
    content: content as ToolResultBlock["content"],
    is_error: isError,
  };
}

describe("fmtPath", () => {
  it("strips home-dir-style prefixes", () => {
    expect(fmtPath("/home/user/app/src/foo.ts")).toBe("app/src/foo.ts");
  });
  it("strips /tmp/<topdir>/", () => {
    expect(fmtPath("/tmp/ambix-smoke/session.jsonl")).toBe("session.jsonl");
  });
  it("strips /Users/<topdir>/", () => {
    expect(fmtPath("/Users/dev/project/src/bar.ts")).toBe("project/src/bar.ts");
  });
  it("strips /users/<topdir>/", () => {
    expect(fmtPath("/users/proj/p/src/foo.ts")).toBe("p/src/foo.ts");
  });
  it("leaves other paths untouched", () => {
    expect(fmtPath("/var/log/foo.log")).toBe("/var/log/foo.log");
  });
  it("handles missing path", () => {
    expect(fmtPath(null)).toBe("<no path>");
  });
});

describe("shorten", () => {
  it("leaves short strings untouched", () => {
    expect(shorten("hello", 10)).toBe("hello");
  });
  it("replaces newlines with ⏎ and truncates", () => {
    expect(shorten("a\nb\nc", 10)).toBe("a ⏎ b ⏎ c");
    expect(shorten("abcdefghij", 5)).toBe("abcd…");
  });
});

describe("diffStat", () => {
  it("returns 1/1 for a single-line edit", () => {
    expect(diffStat("foo", "bar")).toEqual({ added: 1, deleted: 1 });
  });
  it("strips common prefix and suffix", () => {
    const before = "line1\nline2\nline3\nline4";
    const after = "line1\nCHANGED\nline3\nline4";
    expect(diffStat(before, after)).toEqual({ added: 1, deleted: 1 });
  });
  it("counts pure additions", () => {
    expect(diffStat("a\nb", "a\nb\nc\nd")).toEqual({ added: 2, deleted: 0 });
  });
  it("counts pure deletions", () => {
    expect(diffStat("a\nb\nc\nd", "a\nb")).toEqual({ added: 0, deleted: 2 });
  });
});

describe("extractCommit", () => {
  it("pulls hash + subject from a git commit success line", () => {
    const blob = "[main 57bc123abc] feat: add thing\n 3 files changed, 12 insertions(+)";
    expect(extractCommit(result(blob))).toEqual({
      shortHash: "57bc123",
      subject: "feat: add thing",
    });
  });
  it("handles root-commit annotation", () => {
    const blob = "[airdroptoken edd6825 (root-commit)] initial commit";
    expect(extractCommit(result(blob))).toEqual({
      shortHash: "edd6825",
      subject: "initial commit",
    });
  });
  it("returns null when result lacks a commit line", () => {
    expect(extractCommit(result("nothing here"))).toBeNull();
    expect(extractCommit(null)).toBeNull();
  });
});

describe("condenseToolUse — Read", () => {
  it("reports lines + token estimate from cat -n output", () => {
    const catN = "     1\thello\n     2\tworld\n     3\t!";
    const line = condenseToolUse("Read", { file_path: "/users/proj/p/src/foo.ts" }, result(catN));
    expect(line).toContain("Read p/src/foo.ts");
    expect(line).toMatch(/3 lines/);
    expect(line).toMatch(/~\d+ tokens/);
  });
  it("reports offset/limit when set", () => {
    const line = condenseToolUse(
      "Read",
      { file_path: "/users/proj/p/a.ts", offset: 100, limit: 50 },
      result("     1\tx")
    );
    expect(line).toContain("offset=100");
    expect(line).toContain("limit=50");
  });
  it("surfaces errors", () => {
    const line = condenseToolUse(
      "Read",
      { file_path: "/users/proj/p/a.ts" },
      result("ENOENT: no such file", true)
    );
    expect(line).toMatch(/\[error: ENOENT/);
  });
});

describe("condenseToolUse — Edit", () => {
  it("reports diff stat", () => {
    const line = condenseToolUse(
      "Edit",
      {
        file_path: "/users/proj/p/src/foo.ts",
        old_string: "line1\nline2\nline3",
        new_string: "line1\nREPLACED\nline3",
      },
      result("The file has been updated")
    );
    expect(line).toBe("Edit p/src/foo.ts +1 -1");
  });
  it("flags replace_all", () => {
    const line = condenseToolUse(
      "Edit",
      {
        file_path: "/users/proj/p/a.ts",
        old_string: "x",
        new_string: "y",
        replace_all: true,
      },
      result("ok")
    );
    expect(line).toContain("(replace_all)");
  });
});

describe("condenseToolUse — Write", () => {
  it("reports line + token count", () => {
    const content = "line1\nline2\nline3";
    const line = condenseToolUse(
      "Write",
      { file_path: "/users/proj/p/out.txt", content },
      result("ok")
    );
    expect(line).toContain("Write p/out.txt");
    expect(line).toContain("3 lines");
  });
});

describe("condenseToolUse — Bash", () => {
  it("shows the command, description, token size", () => {
    const line = condenseToolUse(
      "Bash",
      { command: "git status", description: "check status" },
      result("On branch main\nnothing to commit")
    );
    expect(line).toContain("Bash `git status`");
    expect(line).toContain("(check status)");
    expect(line).toMatch(/~\d+ tok/);
  });
  it("annotates successful git commit with hash + subject", () => {
    const line = condenseToolUse(
      "Bash",
      { command: "git commit -m 'fix'" },
      result("[main 57bc123] fix: something\n 1 file changed")
    );
    expect(line).toMatch(/→ commit 57bc123/);
    expect(line).toContain("fix: something");
  });
  it("flags errors", () => {
    const line = condenseToolUse("Bash", { command: "false" }, result("", true));
    expect(line).toContain("[error]");
  });
});

describe("condenseToolUse — Grep / Glob", () => {
  it("Grep parses match count", () => {
    const line = condenseToolUse(
      "Grep",
      { pattern: "foo", path: "/home/dev/p/src" },
      result("Found 12 matches")
    );
    expect(line).toContain("Grep");
    expect(line).toContain("12 matches");
  });
  it("Glob counts lines in result", () => {
    const line = condenseToolUse("Glob", { pattern: "**/*.ts" }, result("a.ts\nb.ts\nc.ts"));
    expect(line).toContain("3 matches");
  });
});

describe("condenseToolUse — playwright MCP prefix", () => {
  it("strips the MCP prefix and picks a key field", () => {
    const line = condenseToolUse(
      "mcp__plugin_playwright_playwright__browser_click",
      { element: "Submit button", ref: "btn-42" },
      result("ok")
    );
    expect(line).toContain("browser_click");
    expect(line).toContain("element=");
    expect(line).toContain("Submit button");
  });
  it("produces just the short name when no input fields", () => {
    const line = condenseToolUse(
      "mcp__plugin_playwright_playwright__browser_snapshot",
      {},
      result("...")
    );
    expect(line).toBe("browser_snapshot()");
  });
});

describe("condenseToolUse — generic fallback", () => {
  it("includes tool name + first scalar field", () => {
    const line = condenseToolUse("WeirdTool", { mode: "fast", count: 3 }, result("ok"));
    expect(line).toContain("WeirdTool");
    expect(line).toContain("mode=");
  });
});
