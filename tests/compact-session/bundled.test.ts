import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emitBundled } from "../../src/compact-session/bundled.js";
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

describe("emitBundled", () => {
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

  it("emits a single bundled user-message that wraps every condensed turn in <turns>", async () => {
    const entries = await loadEntries(
      joinLines(
        userLine({ text: "hello", uuid: "u1" }),
        assistantLine({ text: "hi", uuid: "a1" }),
        userLine({ text: "follow-up", uuid: "u2" })
      )
    );

    const { entries: out } = emitBundled({
      sourceEntries: entries,
      newSessionId: "new-session",
      origSessionId: "orig",
      fullRecent: 1,
      cwd: "/work",
      gitBranch: "main",
      version: "2.1.100",
      uuidFn: deterministicUuidFn("uuid"),
      bundledUuid: "bundled-uuid",
      bundledPromptId: "bundled-prompt",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    // Bundle + 1 preserved user entry = 2 total (final round = u2 alone)
    expect(out).toHaveLength(2);

    const bundled = out[0] as {
      type: string;
      uuid: string;
      parentUuid: null | string;
      message: { role: string; content: string };
      sessionId: string;
    };
    expect(bundled.type).toBe("user");
    expect(bundled.uuid).toBe("bundled-uuid");
    expect(bundled.parentUuid).toBeNull();
    expect(bundled.sessionId).toBe("new-session");
    expect(bundled.message.role).toBe("user");

    const content = bundled.message.content;
    expect(content).toContain("<ambix-compaction-marker>");
    expect(content).toContain("orig");
    expect(content).toContain("</ambix-compaction-marker>");
    expect(content).toContain("<turns>");
    expect(content).toContain("</turns>");
    expect(content).toContain('<turn ix="0" kind="user">');
    expect(content).toContain('<turn ix="1" kind="assistant">');
    // Preamble mentions the rehydration command
    expect(content).toContain("ambix query orig");

    const preserved = out[1] as {
      uuid: string;
      parentUuid: string;
      message: { content: unknown };
    };
    expect(preserved.parentUuid).toBe("bundled-uuid"); // chained off the bundle
  });

  it("preserves Task* tool_use + matched tool_result as real entries between the bundle and the preserved tail", async () => {
    const entries = await loadEntries(
      joinLines(
        userLine({ text: "kickoff", uuid: "u0" }),
        toolUseAssistantLine({
          name: "TaskCreate",
          input: { subject: "do the thing", description: "x".repeat(900) },
          toolUseId: "tu_task",
          uuid: "a_task_create",
        }),
        toolResultUserLine({
          toolUseId: "tu_task",
          content: "Task #1 created successfully: do the thing",
          uuid: "u_task_result",
        }),
        assistantLine({ text: "done", uuid: "a_done" }),
        // Preserved tail
        userLine({ text: "continue", uuid: "u_tail" })
      )
    );

    const { entries: out } = emitBundled({
      sourceEntries: entries,
      newSessionId: "sess",
      origSessionId: "orig",
      fullRecent: 1,
      cwd: "/work",
      gitBranch: "main",
      version: "2.1.100",
      uuidFn: deterministicUuidFn("u"),
      bundledUuid: "bundled",
      bundledPromptId: "bp",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    // [0] bundled user-message
    // [1] TaskCreate assistant (verbatim)
    // [2] Task tool_result user (verbatim)
    // [3] preserved-tail user (u_tail)
    expect(out).toHaveLength(4);

    const taskAssistant = out[1] as {
      type: string;
      message: { content: Array<{ type: string; name: string; input: Record<string, unknown> }> };
    };
    expect(taskAssistant.type).toBe("assistant");
    expect(taskAssistant.message.content[0].type).toBe("tool_use");
    expect(taskAssistant.message.content[0].name).toBe("TaskCreate");
    expect(taskAssistant.message.content[0].input.subject).toBe("do the thing");
    // The 900-char description must NOT have been truncated — CC replays it
    expect((taskAssistant.message.content[0].input.description as string).length).toBe(900);

    const taskResult = out[2] as {
      type: string;
      message: { content: Array<{ type: string; tool_use_id: string; content: string }> };
    };
    expect(taskResult.type).toBe("user");
    expect(taskResult.message.content[0].type).toBe("tool_result");
    expect(taskResult.message.content[0].tool_use_id).toBe("tu_task");
    expect(taskResult.message.content[0].content).toBe(
      "Task #1 created successfully: do the thing"
    );

    // parentUuid chain: bundle → taskAssistant → taskResult → preserved-tail
    const bundled = out[0] as { uuid: string };
    const taskAsst = out[1] as { uuid: string; parentUuid: string };
    const taskRes = out[2] as { uuid: string; parentUuid: string };
    const tail = out[3] as { parentUuid: string };
    expect(taskAsst.parentUuid).toBe(bundled.uuid);
    expect(taskRes.parentUuid).toBe(taskAsst.uuid);
    expect(tail.parentUuid).toBe(taskRes.uuid);

    // Task* entries should NOT appear inside the bundle's <turns> section.
    // The preamble may mention "TaskCreate" as an example; isolate the
    // <turns>…</turns> block and assert it's TaskCreate-free.
    const bundleContent = (out[0] as { message: { content: string } }).message.content;
    // Match the actual <turns>…</turns> block (starts with "<turns>\n" — the
    // preamble's in-prose `<turns>` mention has no trailing newline).
    const turnsMatch = bundleContent.match(/<turns>\n([\s\S]*?)<\/turns>/);
    expect(turnsMatch).not.toBeNull();
    expect(turnsMatch?.[1]).not.toContain("TaskCreate");
  });

  it("drops file-history-snapshot entries in the condensed range", async () => {
    const snapshotLine = JSON.stringify({
      type: "file-history-snapshot",
      messageId: "msg_a",
      isSnapshotUpdate: false,
      snapshot: {
        messageId: "msg_a",
        trackedFileBackups: { "/x.ts": { content: "x".repeat(4000), hash: "abc" } },
        timestamp: "2026-04-17T10:00:00Z",
      },
    });
    const entries = await loadEntries(
      joinLines(
        userLine({ text: "start", uuid: "u0" }),
        assistantLine({ text: "edit", uuid: "a0" }),
        snapshotLine,
        userLine({ text: "tail", uuid: "u1" })
      )
    );

    const { entries: out, stats } = emitBundled({
      sourceEntries: entries,
      newSessionId: "s",
      origSessionId: "o",
      fullRecent: 1,
      cwd: "/w",
      gitBranch: "main",
      version: "2.1.100",
      uuidFn: deterministicUuidFn("u"),
      bundledUuid: "bundled",
      bundledPromptId: "bp",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    expect(stats.droppedEntryCount).toBe(1);
    // The 4KB tracked-file payload should NOT appear anywhere
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain("trackedFileBackups");
    expect(serialized).not.toContain("x".repeat(1000));
  });

  it("truncates oversized user text blocks with a <truncated> preview + rehydration marker", async () => {
    const bigText = "A".repeat(2000);
    const entries = await loadEntries(
      joinLines(
        userLine({ text: bigText, uuid: "u_big" }),
        assistantLine({ text: "short reply", uuid: "a" }),
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
      previewChars: 50,
      uuidFn: deterministicUuidFn("u"),
      bundledUuid: "bundled",
      bundledPromptId: "bp",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    expect(stats.truncatedInputFieldCount).toBeGreaterThan(0);
    const content = (out[0] as { message: { content: string } }).message.content;
    expect(content).toContain("<truncated>");
    expect(content).toContain("COMPACTION STUB");
    expect(content).toContain("ambix query orig 0"); // rehydration points at ix=0
    // Preview is present, full 2000-char body is not
    expect(content).toMatch(/A{50}/);
    expect(content).not.toMatch(/A{1000}/);
  });

  it("regenerates routing IDs on every passed-through entry (no source-session IDs leak)", async () => {
    const entries = await loadEntries(
      joinLines(
        userLine({ text: "start", uuid: "u0" }),
        assistantLine({ text: "reply", uuid: "a0" }),
        // preserved tail
        userLine({ text: "tail", uuid: "u_tail" }),
        assistantLine({
          text: "ok",
          uuid: "a_tail",
          model: "claude-opus-4-7",
        })
      )
    );

    const { entries: out } = emitBundled({
      sourceEntries: entries,
      newSessionId: "new-sess",
      origSessionId: "orig",
      fullRecent: 1,
      cwd: "/w",
      gitBranch: "main",
      version: "2.1.100",
      uuidFn: deterministicUuidFn("u"),
      bundledUuid: "bundled",
      bundledPromptId: "bp",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    // Every preserved entry's sessionId matches new-sess; no source "session-test"
    for (const e of out) {
      const rec = e as { sessionId?: unknown };
      if (typeof rec.sessionId === "string") {
        expect(rec.sessionId).toBe("new-sess");
      }
    }
  });

  it("empty source → one bundled message with no <turns>, no preserved entries", async () => {
    const { entries: out, stats } = emitBundled({
      sourceEntries: [],
      newSessionId: "s",
      origSessionId: "orig",
      fullRecent: 5,
      cwd: "/w",
      gitBranch: "main",
      version: "2.1.100",
      uuidFn: deterministicUuidFn("u"),
      bundledUuid: "bundled",
      bundledPromptId: "bp",
      bundledTimestamp: "2026-04-17T10:00:00Z",
    });

    expect(out).toHaveLength(1);
    expect(stats.bundledTurnCount).toBe(0);
    expect(stats.preservedEntryCount).toBe(0);
    const content = (out[0] as { message: { content: string } }).message.content;
    expect(content).toContain("<ambix-compaction-marker>");
    expect(content).not.toContain("<turns>");
  });
});
