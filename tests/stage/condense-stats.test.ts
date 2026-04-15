import { Session } from "parse-claude-logs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { condenseEntriesWithStats } from "../../src/stage/condense.js";
import { formatCondenseStats } from "../../src/stage/format-stats.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

/** Helper: assemble a raw user entry carrying tool_result content blocks. */
function userWithToolResult(opts: {
  toolUseId: string;
  result: unknown;
  uuid?: string;
  parentUuid?: string | null;
  isError?: boolean;
}): string {
  return JSON.stringify({
    type: "user",
    uuid: opts.uuid ?? `uuid-${Math.random().toString(36).slice(2)}`,
    parentUuid: opts.parentUuid ?? null,
    sessionId: "session-test",
    timestamp: "2026-04-13T00:00:00Z",
    cwd: "/work",
    gitBranch: "main",
    version: "2.1.97",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: opts.toolUseId,
          content: opts.result,
          ...(opts.isError ? { is_error: true } : {}),
        },
      ],
    },
  });
}

describe("condenseEntriesWithStats — bucketing and byte accounting", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("buckets tool_use / tool_result by tool name using the tool_use_id map", async () => {
    // Assistant turn 1: a Bash tool_use
    // User turn 2: tool_result for the Bash tool_use
    // Assistant turn 3: a Read tool_use
    // User turn 4: tool_result for the Read tool_use
    const text = joinLines(
      userLine({ text: "prompt", uuid: "u1" }),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        contentBlocks: [
          { type: "tool_use", id: "toolu_bash_1", name: "Bash", input: { command: "ls" } },
        ],
      }),
      userWithToolResult({
        uuid: "u2",
        parentUuid: "a1",
        toolUseId: "toolu_bash_1",
        result: "file1.txt\nfile2.txt",
      }),
      assistantLine({
        uuid: "a2",
        parentUuid: "u2",
        contentBlocks: [
          {
            type: "tool_use",
            id: "toolu_read_1",
            name: "Read",
            input: { file_path: "/x" },
          },
        ],
      }),
      userWithToolResult({
        uuid: "u3",
        parentUuid: "a2",
        toolUseId: "toolu_read_1",
        result: "hello world",
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const { stats } = condenseEntriesWithStats(entries, { maxInlineBytes: 10000 });

    const byKind = Object.fromEntries(stats.rows.map((r) => [r.kind, r]));
    expect(byKind["tool_use:Bash"]?.count).toBe(1);
    expect(byKind["tool_use:Read"]?.count).toBe(1);
    expect(byKind["tool_result:Bash"]?.count).toBe(1);
    expect(byKind["tool_result:Read"]?.count).toBe(1);
    expect(byKind["user:text"]?.count).toBe(1);

    // For unmodified content, origBytes and inlinedBytes should be equal
    // (minor JSON-reshape differences aside) and truncatedCount should be 0.
    expect(byKind["tool_result:Bash"]?.truncatedCount).toBe(0);
    expect(byKind["tool_result:Read"]?.truncatedCount).toBe(0);
  });

  it("records truncation when a tool_result exceeds maxInlineBytes", async () => {
    const big = "x".repeat(5000);
    const text = joinLines(
      userLine({ text: "p", uuid: "u1" }),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        contentBlocks: [
          { type: "tool_use", id: "toolu_big", name: "Bash", input: { command: "big" } },
        ],
      }),
      userWithToolResult({
        uuid: "u2",
        parentUuid: "a1",
        toolUseId: "toolu_big",
        result: big,
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const { stats } = condenseEntriesWithStats(entries, { maxInlineBytes: 100 });
    const bashResult = stats.rows.find((r) => r.kind === "tool_result:Bash");
    expect(bashResult).toBeDefined();
    expect(bashResult?.truncatedCount).toBe(1);
    // Inlined should be smaller than original after stubbing.
    expect(bashResult!.inlinedBytes).toBeLessThan(bashResult!.origBytes);
  });

  it("buckets assistant text and thinking blocks separately", async () => {
    const text = joinLines(
      assistantLine({
        uuid: "a1",
        contentBlocks: [
          { type: "thinking", thinking: "deep thought", signature: "sig123" },
          { type: "text", text: "hello" },
        ],
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const { stats } = condenseEntriesWithStats(entries, { maxInlineBytes: 10000 });
    const kinds = new Set(stats.rows.map((r) => r.kind));
    expect(kinds.has("assistant:text")).toBe(true);
    expect(kinds.has("assistant:thinking")).toBe(true);
  });

  it("records tool_result:<unknown> when the tool_use_id has no matching tool_use", async () => {
    const text = joinLines(
      userLine({ text: "hi", uuid: "u1" }),
      userWithToolResult({
        uuid: "u2",
        parentUuid: "u1",
        toolUseId: "toolu_missing",
        result: "output",
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const { stats } = condenseEntriesWithStats(entries, { maxInlineBytes: 10000 });
    const unknown = stats.rows.find((r) => r.kind === "tool_result:<unknown>");
    expect(unknown?.count).toBe(1);
  });

  it("totals match the sum of rows", async () => {
    const text = joinLines(
      userLine({ text: "prompt", uuid: "u1" }),
      assistantLine({
        uuid: "a1",
        contentBlocks: [
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } },
          { type: "text", text: "running ls now" },
        ],
      }),
      userWithToolResult({ uuid: "u2", toolUseId: "t1", result: "x" })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const { stats } = condenseEntriesWithStats(entries, { maxInlineBytes: 10000 });

    const summedCount = stats.rows.reduce((a, r) => a + r.count, 0);
    const summedOrig = stats.rows.reduce((a, r) => a + r.origBytes, 0);
    const summedInlined = stats.rows.reduce((a, r) => a + r.inlinedBytes, 0);
    const summedTruncated = stats.rows.reduce((a, r) => a + r.truncatedCount, 0);

    expect(stats.totals.count).toBe(summedCount);
    expect(stats.totals.origBytes).toBe(summedOrig);
    expect(stats.totals.inlinedBytes).toBe(summedInlined);
    expect(stats.totals.truncatedCount).toBe(summedTruncated);
  });

  it("does NOT double-count text blocks nested inside a tool_result array content", async () => {
    // Simulate a playwright-style tool_result whose content is an array of
    // text blocks (which is how MCP tools return structured output). The
    // text blocks inside the tool_result MUST be counted under
    // tool_result:<name>, not added a second time to assistant:text.
    const innerText = "x".repeat(2000);
    const text = joinLines(
      userLine({ text: "p", uuid: "u1" }),
      assistantLine({
        uuid: "a1",
        contentBlocks: [{ type: "tool_use", id: "tp1", name: "playwright", input: {} }],
      }),
      JSON.stringify({
        type: "user",
        uuid: "u2",
        parentUuid: "a1",
        sessionId: "session-test",
        timestamp: "2026-04-13T00:00:00Z",
        cwd: "/work",
        gitBranch: "main",
        version: "2.1.97",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tp1",
              content: [
                { type: "text", text: innerText },
                { type: "text", text: "second inner chunk" },
              ],
            },
          ],
        },
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const { stats } = condenseEntriesWithStats(entries, { maxInlineBytes: 10000 });
    // The inner text blocks must NOT surface as a standalone assistant:text row.
    // (They're still reflected in tool_result:playwright's orig/inlined bytes.)
    const assistantText = stats.rows.find((r) => r.kind === "assistant:text");
    expect(assistantText).toBeUndefined();
    const tr = stats.rows.find((r) => r.kind === "tool_result:playwright");
    expect(tr?.count).toBe(1);
    expect(tr!.origBytes).toBeGreaterThan(2000);
  });

  it("deep-truncates large string fields inside attachment payloads", async () => {
    const bigSkillListing = "skill-entry: ".repeat(2000); // ~26 KB
    const text = joinLines(
      JSON.stringify({
        type: "attachment",
        uuid: "at1",
        parentUuid: null,
        sessionId: "session-test",
        timestamp: "2026-04-13T00:00:00Z",
        attachment: {
          type: "skill_listing",
          content: bigSkillListing,
          skillCount: 42,
          isInitial: true,
        },
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const { entries: out, stats } = condenseEntriesWithStats(entries, { maxInlineBytes: 2048 });
    const row = stats.rows.find((r) => r.kind === "other:attachment");
    expect(row?.count).toBe(1);
    expect(row?.truncatedCount).toBe(1);
    expect(row!.inlinedBytes).toBeLessThan(row!.origBytes);
    // The staged content should carry a truncation stub in place of the
    // large `content` string.
    const staged = out[0].content as { attachment: { content: unknown } };
    expect((staged.attachment.content as { truncated?: boolean }).truncated).toBe(true);
  });

  it("deep-truncates large string fields inside system / summary / last-prompt entries", async () => {
    const bigStr = "y".repeat(5000);
    const text = joinLines(
      JSON.stringify({
        type: "summary",
        summary: bigStr,
        leafUuid: "leaf-1",
      }),
      JSON.stringify({
        type: "last-prompt",
        lastPrompt: bigStr,
        sessionId: "s",
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const { stats } = condenseEntriesWithStats(entries, { maxInlineBytes: 500 });
    const summaryRow = stats.rows.find((r) => r.kind === "other:summary");
    const lastPromptRow = stats.rows.find((r) => r.kind === "other:last-prompt");
    expect(summaryRow?.truncatedCount).toBe(1);
    expect(lastPromptRow?.truncatedCount).toBe(1);
    expect(summaryRow!.inlinedBytes).toBeLessThan(summaryRow!.origBytes);
    expect(lastPromptRow!.inlinedBytes).toBeLessThan(lastPromptRow!.origBytes);
  });

  it("stubs thinking block signature when it exceeds the inline budget", async () => {
    const bigSignature = "s".repeat(5000);
    const text = joinLines(
      assistantLine({
        uuid: "a1",
        contentBlocks: [{ type: "thinking", thinking: "short thought", signature: bigSignature }],
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const { entries: out, stats } = condenseEntriesWithStats(entries, { maxInlineBytes: 500 });
    const row = stats.rows.find((r) => r.kind === "assistant:thinking");
    expect(row?.truncatedCount).toBe(1);
    const block = (out[0].content as unknown[])[0] as {
      signature: unknown;
      thinking: unknown;
    };
    // signature got stubbed
    expect((block.signature as { truncated?: boolean }).truncated).toBe(true);
    // thinking stayed inline (short)
    expect(typeof block.thinking).toBe("string");
  });

  it("rows are sorted by origBytes descending", async () => {
    const text = joinLines(
      userLine({ text: "a", uuid: "u1" }),
      assistantLine({
        uuid: "a1",
        contentBlocks: [
          { type: "text", text: "short" },
          { type: "tool_use", id: "t1", name: "BigTool", input: { payload: "z".repeat(500) } },
          { type: "tool_use", id: "t2", name: "TinyTool", input: {} },
        ],
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const { stats } = condenseEntriesWithStats(entries, { maxInlineBytes: 100000 });
    for (let i = 1; i < stats.rows.length; i++) {
      expect(stats.rows[i - 1].origBytes).toBeGreaterThanOrEqual(stats.rows[i].origBytes);
    }
  });
});

describe("formatCondenseStats", () => {
  it("renders a table with headers, rows, separator, and totals", () => {
    const stats = {
      rows: [
        {
          kind: "tool_result:Bash",
          count: 10,
          origBytes: 50_000,
          inlinedBytes: 5_000,
          truncatedCount: 10,
        },
        {
          kind: "assistant:text",
          count: 5,
          origBytes: 2_000,
          inlinedBytes: 2_000,
          truncatedCount: 0,
        },
      ],
      totals: {
        count: 15,
        origBytes: 52_000,
        inlinedBytes: 7_000,
        truncatedCount: 10,
      },
    };
    const out = formatCondenseStats(stats);
    expect(out).toContain("Kind");
    expect(out).toContain("tool_result:Bash");
    expect(out).toContain("assistant:text");
    expect(out).toContain("TOTAL");
    expect(out).toContain("10/10");
    expect(out).toContain("0/5");
    // orig KB column: 50k bytes → 49 KB, 52k → 51 KB
    expect(out).toMatch(/49/);
    expect(out).toMatch(/51/);
  });

  it("includes the title when provided", () => {
    const out = formatCondenseStats(
      { rows: [], totals: { count: 0, origBytes: 0, inlinedBytes: 0, truncatedCount: 0 } },
      { title: "Custom title 123" }
    );
    expect(out).toContain("Custom title 123");
  });
});
