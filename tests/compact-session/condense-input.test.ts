import { describe, expect, it } from "vitest";
import { condenseToolInput } from "../../src/compact-session/condense-input.js";

const OPTS = { maxFieldBytes: 500, previewChars: 50 };

function pickByName<T extends { name: string }>(arr: T[], name: string): T | undefined {
  return arr.find((f) => f.name === name);
}

describe("condenseToolInput — per-tool handlers", () => {
  it("Read: all fields verbatim", () => {
    const c = condenseToolInput(
      "Read",
      { file_path: "src/foo.ts", offset: 0, limit: 50 },
      null,
      OPTS
    );
    expect(c.fields.map((f) => f.name)).toEqual(["file_path", "offset", "limit"]);
    for (const f of c.fields) expect(f.kind).toBe("verbatim");
  });

  it("Edit: file_path verbatim; small strings verbatim", () => {
    const c = condenseToolInput(
      "Edit",
      { file_path: "src/foo.ts", old_string: "a", new_string: "b" },
      null,
      OPTS
    );
    expect(pickByName(c.fields, "file_path")?.kind).toBe("verbatim");
    expect(pickByName(c.fields, "old_string")?.kind).toBe("verbatim");
    expect(pickByName(c.fields, "new_string")?.kind).toBe("verbatim");
  });

  it("Edit: large old_string becomes truncated with preview + origBytes", () => {
    const big = "x".repeat(2000);
    const c = condenseToolInput(
      "Edit",
      { file_path: "src/foo.ts", old_string: big, new_string: "y" },
      null,
      OPTS
    );
    const os = pickByName(c.fields, "old_string");
    expect(os?.kind).toBe("truncated");
    if (os?.kind === "truncated") {
      expect(os.origBytes).toBe(2000);
      expect(os.preview).toHaveLength(50); // previewChars
      expect(os.preview).toBe("x".repeat(50));
    }
    const ns = pickByName(c.fields, "new_string");
    expect(ns?.kind).toBe("verbatim");
  });

  it("Write: content truncatable", () => {
    const big = "z".repeat(1000);
    const c = condenseToolInput("Write", { file_path: "out.txt", content: big }, null, OPTS);
    expect(pickByName(c.fields, "file_path")?.kind).toBe("verbatim");
    expect(pickByName(c.fields, "content")?.kind).toBe("truncated");
  });

  it("Bash: short command verbatim; long command truncatable", () => {
    const short = condenseToolInput(
      "Bash",
      { command: "git log --oneline", description: "recent commits", timeout: 5000 },
      null,
      OPTS
    );
    expect(pickByName(short.fields, "command")?.kind).toBe("verbatim");
    expect(pickByName(short.fields, "description")?.kind).toBe("verbatim");

    const big = condenseToolInput("Bash", { command: `echo '${"a".repeat(2000)}'` }, null, OPTS);
    expect(pickByName(big.fields, "command")?.kind).toBe("truncated");
  });

  it("Grep: every option passes through verbatim", () => {
    const c = condenseToolInput(
      "Grep",
      {
        pattern: "Session\\.",
        path: "src/",
        glob: "*.ts",
        "-n": true,
        output_mode: "files_with_matches",
      },
      null,
      OPTS
    );
    for (const f of c.fields) expect(f.kind).toBe("verbatim");
    // Field order reflects the handler's pick-list order; assert the set is present.
    expect(new Set(c.fields.map((f) => f.name))).toEqual(
      new Set(["pattern", "path", "glob", "-n", "output_mode"])
    );
  });

  it("Task: prompt is truncatable; scalar fields verbatim", () => {
    const small = condenseToolInput(
      "Task",
      { subagent_type: "Explore", description: "find auth", prompt: "short prompt" },
      null,
      OPTS
    );
    expect(pickByName(small.fields, "prompt")?.kind).toBe("verbatim");

    const big = condenseToolInput(
      "Task",
      {
        subagent_type: "Explore",
        description: "big task",
        prompt: "huge prompt ".repeat(200),
      },
      null,
      OPTS
    );
    expect(pickByName(big.fields, "prompt")?.kind).toBe("truncated");
    expect(pickByName(big.fields, "subagent_type")?.kind).toBe("verbatim");
  });

  it("PRESERVE_TOOLS (TaskCreate): every field verbatim even if oversized", () => {
    const c = condenseToolInput(
      "TaskCreate",
      { subject: "x", description: "x".repeat(2000) },
      null,
      OPTS
    );
    for (const f of c.fields) expect(f.kind).toBe("verbatim");
    const desc = pickByName(c.fields, "description");
    expect(desc?.kind).toBe("verbatim");
    if (desc?.kind === "verbatim") expect((desc.value as string).length).toBe(2000);
  });

  it("MultiEdit: file_path verbatim; edits array size-swept in-place", () => {
    const c = condenseToolInput(
      "MultiEdit",
      {
        file_path: "src/foo.ts",
        edits: [
          { old_string: "small1", new_string: "tiny" },
          { old_string: "y".repeat(2000), new_string: "small2" },
        ],
      },
      null,
      OPTS
    );
    expect(pickByName(c.fields, "file_path")?.kind).toBe("verbatim");
    const edits = pickByName(c.fields, "edits");
    expect(edits?.kind).toBe("verbatim");
    if (edits?.kind === "verbatim") {
      const arr = edits.value as Array<Record<string, unknown>>;
      expect(arr).toHaveLength(2);
      expect(arr[0].old_string).toBe("small1");
      // The oversized string is replaced with a compact sentinel — NOT the
      // "[COMPACTION STUB …]" pattern that pattern-match-echo caused failures.
      expect(arr[1].old_string).toMatch(/^\[truncated: 2000 bytes/);
      expect(arr[1].old_string).not.toMatch(/ambix query/);
      expect(arr[1].new_string).toBe("small2");
    }
  });

  it("Generic (unknown mcp): walks object, truncates oversized leaf strings", () => {
    const c = condenseToolInput(
      "mcp__plugin__opaque",
      {
        param1: "small",
        param3: "z".repeat(2000),
        nested: { inner: "q".repeat(2000) },
      },
      null,
      OPTS
    );
    expect(pickByName(c.fields, "param1")?.kind).toBe("verbatim");
    expect(pickByName(c.fields, "param3")?.kind).toBe("truncated");
    // Nested object: sweep replaces oversized leaves with a sentinel
    const nested = pickByName(c.fields, "nested");
    expect(nested?.kind).toBe("verbatim");
    if (nested?.kind === "verbatim") {
      const v = nested.value as { inner: string };
      expect(v.inner).toMatch(/^\[truncated: 2000 bytes/);
    }
  });

  it("previewChars=0 produces marker-only truncated field", () => {
    const c = condenseToolInput(
      "Edit",
      { file_path: "x", old_string: "y".repeat(2000), new_string: "z" },
      null,
      { maxFieldBytes: 500, previewChars: 0 }
    );
    const os = pickByName(c.fields, "old_string");
    expect(os?.kind).toBe("truncated");
    if (os?.kind === "truncated") expect(os.preview).toBe("");
  });

  it("resultSummary carries the one-liner for <tool_result> body", () => {
    const c = condenseToolInput(
      "Read",
      { file_path: "src/foo.ts", offset: 0, limit: 50 },
      null,
      OPTS
    );
    // Don't assert exact string (condenser implementation detail) — just
    // that it's a non-empty summary mentioning the file path.
    expect(c.resultSummary.length).toBeGreaterThan(0);
    expect(c.resultSummary).toContain("foo.ts");
  });
});
