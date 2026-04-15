import { Session, parsePersistedOutput } from "parse-claude-logs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { condenseEntries } from "../../src/stage/condense.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("condenseEntries — basic", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("assigns sequential ix values starting at 0", async () => {
    const text = joinLines(
      userLine({ text: "first", uuid: "u1" }),
      assistantLine({ text: "second", uuid: "a1", parentUuid: "u1" })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });

    expect(result).toHaveLength(2);
    expect(result[0].ix).toBe(0);
    expect(result[1].ix).toBe(1);
  });

  it("preserves uuid in ref field", async () => {
    const text = joinLines(userLine({ text: "x", uuid: "abc-123" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].ref).toBe("uuid:abc-123");
  });

  it("computes parent_ix from parentUuid linkage", async () => {
    const text = joinLines(
      userLine({ text: "first", uuid: "u1", parentUuid: null }),
      assistantLine({ text: "reply", uuid: "a1", parentUuid: "u1" })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].parent_ix).toBe(null);
    expect(result[1].parent_ix).toBe(0);
  });

  it("includes assistant token usage", async () => {
    const text = joinLines(
      assistantLine({ text: "x", inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].tokens).toEqual({ in: 100, out: 50, cache_read: 20 });
  });

  it("flags synthetic-model assistant entries", async () => {
    const text = joinLines(assistantLine({ text: "synthetic", model: "<synthetic>" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].synthetic).toBe(true);
  });

  it("preserves content unchanged when below truncation threshold", async () => {
    const text = joinLines(userLine({ text: "small content" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].content).toBe("small content");
  });
});

describe("condenseEntries — truncation", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("replaces large user content with a rehydration stub", async () => {
    const big = "x".repeat(5000);
    const text = joinLines(userLine({ text: big, uuid: "u1" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 100 });

    const content = result[0].content as {
      truncated: true;
      ref: string;
      bytes: number;
      tokens_est: number;
      preview: string;
    };
    expect(content.truncated).toBe(true);
    expect(content.ref).toBe("turns/00000.json");
    expect(content.bytes).toBeGreaterThan(100);
    expect(content.tokens_est).toBeGreaterThan(0);
    expect(content.preview.length).toBeGreaterThan(0);
  });

  it("replaces large tool_use input string fields with per-field stubs, keeping small fields inline", async () => {
    const big = "y".repeat(5000);
    const text = joinLines(
      assistantLine({
        contentBlocks: [
          {
            type: "tool_use",
            id: "toolu_X",
            name: "Edit",
            input: { file_path: "src/big.ts", old_string: big, new_string: "ok" },
          },
        ],
        uuid: "a1",
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 100 });
    const blocks = result[0].content as Array<Record<string, unknown>>;
    const tu = blocks[0] as {
      type: string;
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

    expect(tu.type).toBe("tool_use");
    expect(tu.id).toBe("toolu_X");
    expect(tu.name).toBe("Edit");

    // Small fields stay inline
    expect(tu.input.file_path).toBe("src/big.ts");
    expect(tu.input.new_string).toBe("ok");

    // Large field becomes a stub
    const oldStub = tu.input.old_string as {
      truncated: boolean;
      ref: string;
      bytes: number;
      tokens_est: number;
      preview: string;
    };
    expect(oldStub.truncated).toBe(true);
    expect(oldStub.ref).toBe("turns/00000.json");
    expect(oldStub.bytes).toBeGreaterThan(100);
    expect(oldStub.preview.length).toBeGreaterThan(0);
    // Preview should contain the actual character(s) from the original
    expect(oldStub.preview.startsWith("y")).toBe(true);
  });

  it("replaces persisted-output tool_results with a spill stub", async () => {
    const persisted =
      "<persisted-output>\nOutput too large (51.3KB). Full output saved to: /abs/path/tool-results/toolu_X.json\n\nPreview (first 2KB):\nfirst few lines of the spill\n";
    // sanity: parse-claude-logs detects this format
    expect(parsePersistedOutput(persisted)).not.toBe(null);

    const text = joinLines(
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "session-test",
        timestamp: "2026-04-13T10:00:00Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_X", content: persisted }],
        },
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    const blocks = result[0].content as Array<Record<string, unknown>>;
    const tr = blocks[0] as {
      type: string;
      tool_use_id: string;
      result: { truncated: boolean; ref: string; bytes: number; preview: string };
    };
    expect(tr.type).toBe("tool_result");
    expect(tr.tool_use_id).toBe("toolu_X");
    expect(tr.result.truncated).toBe(true);
    expect(tr.result.ref).toBe("spill/toolu_X.json");
    expect(tr.result.preview).toContain("first few lines");
  });
});

describe("condenseEntries — non-message entry preservation", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("preserves permission-mode entry payload in content", async () => {
    const text = joinLines(
      JSON.stringify({
        type: "permission-mode",
        sessionId: "session-test",
        permissionMode: "bypassPermissions",
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].type).toBe("permission-mode");
    expect(result[0].content).toEqual({ permissionMode: "bypassPermissions" });
  });

  it("preserves file-history-snapshot entry payload", async () => {
    const snapshot = {
      messageId: "msg_1",
      timestamp: "2026-04-13T10:00:00Z",
      trackedFileBackups: {
        "src/foo.ts": { backupFileName: "abc@v1", version: 1, backupTime: "2026-04-13T10:00:00Z" },
      },
    };
    const text = joinLines(
      JSON.stringify({
        type: "file-history-snapshot",
        messageId: "msg_1",
        snapshot,
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].type).toBe("file-history-snapshot");
    const content = result[0].content as { messageId: string; snapshot: typeof snapshot };
    expect(content.messageId).toBe("msg_1");
    expect(content.snapshot).toEqual(snapshot);
  });

  it("preserves last-prompt entry payload", async () => {
    const text = joinLines(
      JSON.stringify({
        type: "last-prompt",
        sessionId: "session-test",
        lastPrompt: "hello there",
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 10000 });
    expect(result[0].type).toBe("last-prompt");
    expect(result[0].content).toEqual({ lastPrompt: "hello there" });
  });
});

describe("condenseEntries — block-field truncation details", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("replaces a text block's text field with a stub when too large, keeping the block wrapper", async () => {
    const big = "z".repeat(5000);
    const text = joinLines(
      assistantLine({
        contentBlocks: [{ type: "text", text: big }],
        uuid: "a1",
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 100 });
    const blocks = result[0].content as Array<Record<string, unknown>>;
    const tb = blocks[0] as {
      type: string;
      text: { truncated: boolean; ref: string; preview: string };
    };

    expect(tb.type).toBe("text");
    expect(tb.text.truncated).toBe(true);
    expect(tb.text.ref).toBe("turns/00000.json");
    expect(tb.text.preview.length).toBeGreaterThan(0);
    expect(tb.text.preview.startsWith("z")).toBe(true);
  });

  it("keeps image blocks unchanged regardless of size", async () => {
    const text = joinLines(
      assistantLine({
        contentBlocks: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo..." },
          },
        ],
        uuid: "a1",
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const result = condenseEntries(entries, { maxInlineBytes: 100 });
    const blocks = result[0].content as Array<Record<string, unknown>>;
    expect(blocks[0].type).toBe("image");
    expect((blocks[0] as { source: { type: string } }).source).toBeDefined();
  });
});
