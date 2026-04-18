import { describe, expect, it } from "vitest";
import { condenseToolInput } from "../../src/compact-session/condense-input.js";
import {
  renderToolResultXml,
  renderToolUseXml,
} from "../../src/compact-session/render-bundled-xml.js";

const OPTS = { maxFieldBytes: 500, previewChars: 50 };

// Minimal ToolUseBlock / ToolResultBlock stand-ins for tests. parse-cc's
// exported types are structural, so plain objects matching the shape suffice.
function toolUse(name: string, input: unknown, id = "toolu_X") {
  return { type: "tool_use" as const, name, input, id };
}
function toolResult(content: string, isError = false, toolUseId = "toolu_X") {
  return { type: "tool_result" as const, tool_use_id: toolUseId, content, is_error: isError };
}

describe("renderToolUseXml", () => {
  it("Read — per-field children, no id, ix on the opening tag", () => {
    const use = toolUse("Read", { file_path: "src/foo.ts", offset: 0, limit: 50 });
    const condensed = condenseToolInput("Read", use.input, null, OPTS);
    const xml = renderToolUseXml(use, 10, condensed);
    expect(xml).toContain('<tool_use name="Read" ix="10">');
    expect(xml).toContain("<file_path>src/foo.ts</file_path>");
    expect(xml).toContain("<offset>0</offset>");
    expect(xml).toContain("<limit>50</limit>");
    expect(xml).not.toContain("toolu_"); // no tool_use_id
    expect(xml).not.toContain("summary="); // stats live on tool_result
  });

  it("Edit (small) — inputs verbatim", () => {
    const use = toolUse("Edit", {
      file_path: "src/x.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    });
    const condensed = condenseToolInput("Edit", use.input, null, OPTS);
    const xml = renderToolUseXml(use, 12, condensed);
    expect(xml).toContain("<old_string>const x = 1;</old_string>");
    expect(xml).toContain("<new_string>const x = 2;</new_string>");
    expect(xml).not.toContain("truncated=");
  });

  it("Edit (large) — truncated attribute on field, preview body ending with …", () => {
    const use = toolUse("Edit", {
      file_path: "src/x.ts",
      old_string: "x".repeat(2000),
      new_string: "y".repeat(2000),
    });
    const condensed = condenseToolInput("Edit", use.input, null, OPTS);
    const xml = renderToolUseXml(use, 12, condensed);
    expect(xml).toMatch(/<old_string truncated="2000">x{50}…<\/old_string>/);
    expect(xml).toMatch(/<new_string truncated="2000">y{50}…<\/new_string>/);
    // Crucially NOT the pattern that caused the failure:
    expect(xml).not.toContain("<truncated>");
    expect(xml).not.toContain("[COMPACTION STUB");
    expect(xml).not.toContain("ambix query");
  });

  it("Bash — command verbatim when small, truncated when large", () => {
    const small = toolUse("Bash", { command: "git log --oneline", description: "commits" });
    const sc = condenseToolInput("Bash", small.input, null, OPTS);
    const smallXml = renderToolUseXml(small, 15, sc);
    expect(smallXml).toContain("<command>git log --oneline</command>");
    expect(smallXml).toContain("<description>commits</description>");

    const big = toolUse("Bash", { command: `echo '${"a".repeat(2000)}'` });
    const bc = condenseToolInput("Bash", big.input, null, OPTS);
    const bigXml = renderToolUseXml(big, 16, bc);
    expect(bigXml).toMatch(/<command truncated="\d+">/);
  });

  it("Task — prompt truncated when large; scalar fields verbatim", () => {
    const use = toolUse("Task", {
      subagent_type: "Explore",
      description: "find auth",
      prompt: "find all authentication-related files. ".repeat(200),
    });
    const condensed = condenseToolInput("Task", use.input, null, OPTS);
    const xml = renderToolUseXml(use, 20, condensed);
    expect(xml).toContain("<subagent_type>Explore</subagent_type>");
    expect(xml).toContain("<description>find auth</description>");
    expect(xml).toMatch(/<prompt truncated="\d+">/);
  });

  it("PRESERVE_TOOLS (TaskCreate) — every field verbatim regardless of size", () => {
    const use = toolUse("TaskCreate", {
      subject: "x",
      description: "y".repeat(2000),
    });
    const condensed = condenseToolInput("TaskCreate", use.input, null, OPTS);
    const xml = renderToolUseXml(use, 30, condensed);
    expect(xml).toContain("<subject>x</subject>");
    // The 2000-char description passes through UNTRUNCATED (CC replays it)
    expect(xml).not.toContain("truncated=");
    expect(xml).toContain(`<description>${"y".repeat(2000)}</description>`);
  });

  it("Empty input — self-closing tool_use tag", () => {
    const use = toolUse("Unknown", {});
    const condensed = condenseToolInput("Unknown", use.input, null, OPTS);
    const xml = renderToolUseXml(use, 99, condensed);
    expect(xml).toBe('<tool_use name="Unknown" ix="99"/>');
  });

  it("Strips XML-illegal control bytes from tool_use input text", () => {
    // NUL + ESC in a Bash command. renderer must strip both so the outer
    // <turns> block stays parseable.
    const use = toolUse("Bash", { command: "echo \u0000 \u001b[31mred" });
    const condensed = condenseToolInput("Bash", use.input, null, OPTS);
    const xml = renderToolUseXml(use, 1, condensed);
    expect(xml.includes("\u0000")).toBe(false);
    expect(xml.includes("\u001b")).toBe(false);
  });

  it("Sanitizes field names containing non-XML-safe characters", () => {
    // Hyphens are OK in XML NameChar; `@` is not. A leading hyphen is NOT
    // a valid NameStart and must be prefixed.
    const use = toolUse("mcp__plugin__http", {
      "x-header": "ok",
      "foo@bar": "q",
      "-weird": "z",
    });
    const condensed = condenseToolInput("mcp__plugin__http", use.input, null, OPTS);
    const xml = renderToolUseXml(use, 5, condensed);
    expect(xml).toContain("<x-header>ok</x-header>"); // hyphen passes through
    expect(xml).toContain("<foo_bar>q</foo_bar>"); // @ replaced
    expect(xml).toContain("<_-weird>z</_-weird>"); // leading hyphen prefixed
  });

  it("Nested object input is JSON-rendered inside its field tag", () => {
    const use = toolUse("mcp__plugin__opaque", {
      config: { retries: 3, host: "x.com" },
    });
    const condensed = condenseToolInput("mcp__plugin__opaque", use.input, null, OPTS);
    const xml = renderToolUseXml(use, 6, condensed);
    expect(xml).toContain("<config>");
    expect(xml).toContain('{"retries":3,"host":"x.com"}');
  });
});

describe("renderToolResultXml", () => {
  it("Emits ix, name, and summary body — no id, no tool_use_id", () => {
    const block = toolResult("50 lines, ~2k tok");
    const xml = renderToolResultXml(block, 11, "Read", "50 lines, ~2k tok");
    expect(xml).toBe('<tool_result ix="11" name="Read">50 lines, ~2k tok</tool_result>');
  });

  it("Marks errored results with error=true attribute", () => {
    const block = toolResult("Exit 1", true);
    const xml = renderToolResultXml(block, 16, "Bash", "Exit 1: permission denied");
    expect(xml).toContain('ix="16"');
    expect(xml).toContain('name="Bash"');
    expect(xml).toContain('error="true"');
    expect(xml).toContain(">Exit 1: permission denied</tool_result>");
  });

  it("Self-closes when the summary is empty", () => {
    const block = toolResult("");
    const xml = renderToolResultXml(block, 5, "X", "");
    expect(xml).toBe('<tool_result ix="5" name="X"/>');
  });

  it("Escapes XML reserved chars in the summary", () => {
    const block = toolResult("");
    const xml = renderToolResultXml(block, 7, "Bash", "echo '<script>' & more");
    expect(xml).toContain("&lt;script&gt;");
    expect(xml).toContain("&amp;");
  });
});
