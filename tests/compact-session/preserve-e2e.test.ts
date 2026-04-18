import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitBundled } from "../../src/compact-session/bundled.js";
import { parseSelector } from "../../src/compact-session/preserve-selector.js";
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

describe("emitBundled — --preserve selectors", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  async function loadEntries(text: string) {
    const session = new Session(writeFixture(dir, "src.jsonl", text));
    return await session.messages();
  }

  function deterministicUuidFn(prefix: string) {
    let n = 0;
    return () => `${prefix}-${String(n++).padStart(4, "0")}`;
  }

  it("tool: selector preserves a user-specified tool's input verbatim inside <turns>", async () => {
    // Big prompt that would ordinarily be truncated. With --preserve
    // tool:mcp__telegram__*, it should pass through verbatim.
    const bigPrompt = "Hey, this is an important message. ".repeat(50); // ~1800 bytes
    const entries = await loadEntries(
      joinLines(
        userLine({ text: "start", uuid: "u0" }),
        toolUseAssistantLine({
          name: "mcp__telegram__send_message",
          input: { chat_id: 123, text: bigPrompt },
          toolUseId: "tu_tg",
          uuid: "a_tg",
        }),
        toolResultUserLine({
          toolUseId: "tu_tg",
          content: "sent — message_id 42",
          uuid: "u_tg_result",
        }),
        userLine({ text: "tail", uuid: "u_tail" })
      )
    );

    const { entries: out, stats } = emitBundled({
      sourceEntries: entries,
      newSessionId: "s",
      origSessionId: "orig",
      fullRecent: 1,
      cwd: "/w",
      gitBranch: "main",
      version: "2.1.100",
      maxFieldBytes: 500, // would normally truncate the 1800-char prompt
      preserveSelectors: [parseSelector("tool:mcp__telegram__*")],
      uuidFn: deterministicUuidFn("u"),
      bundledUuid: "bundled",
      bundledPromptId: "bp",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    // The tool_use + tool_result still live INSIDE the bundled <turns>
    // block — they should NOT be promoted to real JSONL entries.
    expect(out).toHaveLength(2); // bundled + preserved tail

    const content = (out[0] as { message: { content: string } }).message.content;
    // The full prompt is present verbatim. Check specifically the <turns>
    // block — the preamble itself describes truncated="<bytes>" as an
    // explanatory string.
    expect(content).toContain(bigPrompt);
    const turns = content.match(/<turns>\n([\s\S]*?)<\/turns>/)?.[1] ?? "";
    expect(turns).not.toContain('truncated="');

    // The tool_result body is the real content, not a condenser one-liner.
    expect(content).toMatch(
      /<tool_result ix="\d+" name="mcp__telegram__send_message">[\s\S]*?sent — message_id 42[\s\S]*?<\/tool_result>/
    );

    // Stats track the preservation
    expect(stats.userPreservedToolCount).toBeGreaterThan(0);
  });

  it("tool: selector does not affect non-matching tools", async () => {
    const bigOldString = "y".repeat(2000);
    const entries = await loadEntries(
      joinLines(
        userLine({ text: "start", uuid: "u0" }),
        toolUseAssistantLine({
          name: "Edit",
          input: { file_path: "src/x.ts", old_string: bigOldString, new_string: "z" },
          toolUseId: "tu_edit",
          uuid: "a_edit",
        }),
        userLine({ text: "tail", uuid: "u_tail" })
      )
    );

    const { entries: out } = emitBundled({
      sourceEntries: entries,
      newSessionId: "s",
      origSessionId: "orig",
      fullRecent: 1,
      cwd: "/w",
      gitBranch: "main",
      version: "2.1.100",
      maxFieldBytes: 500,
      preserveSelectors: [parseSelector("tool:mcp__telegram__*")], // won't match Edit
      uuidFn: deterministicUuidFn("u"),
      bundledUuid: "bundled",
      bundledPromptId: "bp",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    const content = (out[0] as { message: { content: string } }).message.content;
    // Edit's big old_string was truncated as usual
    expect(content).toMatch(/<old_string truncated="2000">/);
    expect(content).not.toMatch(/y{1000}/);
  });

  it("type: selector promotes matching entries to real JSONL pass-through", async () => {
    const snapshotLine = JSON.stringify({
      type: "file-history-snapshot",
      messageId: "msg_a",
      isSnapshotUpdate: false,
      snapshot: {
        messageId: "msg_a",
        trackedFileBackups: { "/x.ts": { content: "real content", hash: "abc" } },
        timestamp: "2026-04-17T10:00:00Z",
      },
    });
    const entries = await loadEntries(
      joinLines(
        userLine({ text: "start", uuid: "u0" }),
        assistantLine({ text: "edit", uuid: "a0" }),
        snapshotLine,
        userLine({ text: "tail", uuid: "u_tail" })
      )
    );

    const { entries: out, stats } = emitBundled({
      sourceEntries: entries,
      newSessionId: "s",
      origSessionId: "orig",
      fullRecent: 1,
      cwd: "/w",
      gitBranch: "main",
      version: "2.1.100",
      preserveSelectors: [parseSelector("type:file-history-snapshot")],
      uuidFn: deterministicUuidFn("u"),
      bundledUuid: "bundled",
      bundledPromptId: "bp",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    // The snapshot entry is emitted as a real JSONL entry (not dropped,
    // not rendered into the bundled XML).
    expect(stats.userPreservedTypeCount).toBe(1);
    expect(stats.droppedEntryCount).toBe(0);

    const snapshotEntry = out.find(
      (e) => (e as { type?: string }).type === "file-history-snapshot"
    );
    expect(snapshotEntry).toBeDefined();
    // The payload is verbatim (the 'real content' string is still there).
    expect(JSON.stringify(snapshotEntry)).toContain("real content");

    // The bundled message did NOT summarize the snapshot in <turns>.
    // (The preamble itself mentions the selector pattern, which legitimately
    // contains "file-history-snapshot" as a literal string.)
    const content = (out[0] as { message: { content: string } }).message.content;
    const turns = content.match(/<turns>\n([\s\S]*?)<\/turns>/)?.[1] ?? "";
    expect(turns).not.toContain("file-history-snapshot");
  });

  it("type: selector without a match behaves as if no selector was given", async () => {
    const snapshotLine = JSON.stringify({
      type: "file-history-snapshot",
      messageId: "msg_a",
      isSnapshotUpdate: false,
      snapshot: {
        messageId: "msg_a",
        trackedFileBackups: { "/x.ts": { content: "x", hash: "a" } },
        timestamp: "2026-04-17T10:00:00Z",
      },
    });
    const entries = await loadEntries(
      joinLines(
        userLine({ text: "start", uuid: "u0" }),
        snapshotLine,
        userLine({ text: "tail", uuid: "u_tail" })
      )
    );

    const { stats } = emitBundled({
      sourceEntries: entries,
      newSessionId: "s",
      origSessionId: "orig",
      fullRecent: 1,
      cwd: "/w",
      gitBranch: "main",
      version: "2.1.100",
      preserveSelectors: [parseSelector("type:custom-title")], // doesn't match
      uuidFn: deterministicUuidFn("u"),
      bundledUuid: "bundled",
      bundledPromptId: "bp",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    // Default behavior: file-history-snapshot gets dropped
    expect(stats.droppedEntryCount).toBe(1);
    expect(stats.userPreservedTypeCount).toBe(0);
  });

  it("case-sensitive matching: tool:bash does not match tool name 'Bash'", async () => {
    const entries = await loadEntries(
      joinLines(
        userLine({ text: "start", uuid: "u0" }),
        toolUseAssistantLine({
          name: "Bash",
          input: { command: "A".repeat(2000) }, // would be truncated
          toolUseId: "tu_b",
          uuid: "a_b",
        }),
        userLine({ text: "tail", uuid: "u_tail" })
      )
    );

    const { entries: out } = emitBundled({
      sourceEntries: entries,
      newSessionId: "s",
      origSessionId: "orig",
      fullRecent: 1,
      cwd: "/w",
      gitBranch: "main",
      version: "2.1.100",
      maxFieldBytes: 500,
      preserveSelectors: [parseSelector("tool:bash")], // lowercase
      uuidFn: deterministicUuidFn("u"),
      bundledUuid: "bundled",
      bundledPromptId: "bp",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    const content = (out[0] as { message: { content: string } }).message.content;
    // Not preserved — truncation applied as usual.
    expect(content).toMatch(/<command truncated="\d+">/);
  });

  it("combining multiple selectors: tool: + type: applied in the same run", async () => {
    const snapshotLine = JSON.stringify({
      type: "custom-title",
      title: "Preserve Me",
      timestamp: "2026-04-17T10:00:00Z",
    });
    const entries = await loadEntries(
      joinLines(
        userLine({ text: "start", uuid: "u0" }),
        toolUseAssistantLine({
          name: "mcp__slack__post",
          input: { channel: "#general", text: "Z".repeat(2000) },
          toolUseId: "tu_slack",
          uuid: "a_slack",
        }),
        snapshotLine,
        userLine({ text: "tail", uuid: "u_tail" })
      )
    );

    const { entries: out, stats } = emitBundled({
      sourceEntries: entries,
      newSessionId: "s",
      origSessionId: "orig",
      fullRecent: 1,
      cwd: "/w",
      gitBranch: "main",
      version: "2.1.100",
      maxFieldBytes: 500,
      preserveSelectors: [parseSelector("tool:mcp__slack__*"), parseSelector("type:custom-title")],
      uuidFn: deterministicUuidFn("u"),
      bundledUuid: "bundled",
      bundledPromptId: "bp",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    // Both stats counters incremented
    expect(stats.userPreservedToolCount).toBeGreaterThan(0);
    expect(stats.userPreservedTypeCount).toBe(1);

    // tool:* → inside <turns> block, verbatim
    const content = (out[0] as { message: { content: string } }).message.content;
    expect(content).toContain("Z".repeat(2000));
    expect(content).not.toMatch(/<text truncated=/);

    // type:* → promoted as real JSONL, not in <turns>
    const titleEntry = out.find((e) => (e as { type?: string }).type === "custom-title");
    expect(titleEntry).toBeDefined();
    expect(JSON.stringify(titleEntry)).toContain("Preserve Me");
  });
});
