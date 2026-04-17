import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emit } from "../../src/compact-session/emit.js";
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

// Deterministic uuid generator for tests — returns predictable strings.
function makeUuidFn() {
  let i = 0;
  return () => `u${(++i).toString().padStart(3, "0")}`;
}

const baseEmit = {
  newSessionId: "new-sess",
  origSessionId: "orig-sess",
  cwd: "/work",
  gitBranch: "main",
  version: "2.1.110",
  summaryUuid: "summary",
  summaryPromptId: "prompt",
  summaryTimestamp: "2026-04-17T12:00:00.000Z",
};

describe("emit", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  async function loadSession(text: string) {
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    return session.messages();
  }

  it("normal split — condenses earlier rounds, preserves last N, divider between", async () => {
    const entries = await loadSession(
      joinLines(
        userLine({ text: "round 1", uuid: "s1" }),
        assistantLine({ text: "r1 reply", uuid: "s2" }),
        userLine({ text: "round 2", uuid: "s3" }),
        assistantLine({ text: "r2 reply", uuid: "s4" })
      )
    );

    const { entries: out, stats } = emit({
      ...baseEmit,
      sourceEntries: entries,
      fullRecent: 1,
      uuidFn: makeUuidFn(),
    });

    // 4 source entries + 1 divider = 5 emitted
    expect(out).toHaveLength(5);
    expect(stats.sourceEntryCount).toBe(4);
    expect(stats.condensedEntryCount).toBe(2); // round 1 (user + assistant)
    expect(stats.preservedEntryCount).toBe(2); // round 2

    // Divider sits between round 1 and round 2
    expect(out[0].type).toBe("user"); // round 1 user
    expect(out[1].type).toBe("assistant"); // round 1 assistant
    expect((out[2].message as { content?: string }).content).toContain("ambix-compaction-marker"); // divider
    expect(out[3].type).toBe("user"); // round 2 user
    expect(out[4].type).toBe("assistant"); // round 2 assistant
  });

  it("rewrites sessionId on every emitted entry", async () => {
    const entries = await loadSession(
      joinLines(
        userLine({ text: "hi", sessionId: "original-session-uuid" }),
        assistantLine({ text: "hi back", sessionId: "original-session-uuid" })
      )
    );

    const { entries: out } = emit({
      ...baseEmit,
      sourceEntries: entries,
      fullRecent: 10,
      uuidFn: makeUuidFn(),
    });

    for (const e of out) {
      expect(e.sessionId).toBe("new-sess");
    }
  });

  it("rebuilds parentUuid chain linearly — first=null, subsequent=previous.uuid", async () => {
    const entries = await loadSession(
      joinLines(
        userLine({ text: "1", uuid: "a" }),
        assistantLine({ text: "2", uuid: "b" }),
        userLine({ text: "3", uuid: "c" }),
        assistantLine({ text: "4", uuid: "d" })
      )
    );

    const { entries: out } = emit({
      ...baseEmit,
      sourceEntries: entries,
      fullRecent: 1,
      uuidFn: makeUuidFn(),
    });

    expect(out[0].parentUuid).toBeNull();
    for (let i = 1; i < out.length; i++) {
      expect(out[i].parentUuid).toBe(out[i - 1].uuid);
    }
  });

  it("stubs tool_result content in condensed section; preserves it in the preserved section", async () => {
    const entries = await loadSession(
      joinLines(
        // Round 1 — should be condensed
        userLine({ text: "read a file", uuid: "u1" }),
        toolUseAssistantLine({
          name: "Read",
          input: { file_path: "/tmp/a.txt" },
          toolUseId: "tu_A",
          uuid: "a1",
        }),
        toolResultUserLine({
          toolUseId: "tu_A",
          content: "AAA".repeat(200), // 600 bytes
          uuid: "r1",
        }),
        // Round 2 — should be preserved
        userLine({ text: "read another", uuid: "u2" }),
        toolUseAssistantLine({
          name: "Read",
          input: { file_path: "/tmp/b.txt" },
          toolUseId: "tu_B",
          uuid: "a2",
        }),
        toolResultUserLine({
          toolUseId: "tu_B",
          content: "BBB".repeat(200), // 600 bytes
          uuid: "r2",
        })
      )
    );

    const { entries: out, stats } = emit({
      ...baseEmit,
      sourceEntries: entries,
      fullRecent: 1,
      uuidFn: makeUuidFn(),
    });

    // Find the tool_result entries by shape
    const toolResultEntries = out.filter((e) => {
      const msg = (e as { message?: { content?: unknown } }).message;
      if (!msg?.content || !Array.isArray(msg.content)) return false;
      return (msg.content as Array<{ type?: string }>).some((b) => b.type === "tool_result");
    });
    expect(toolResultEntries).toHaveLength(2);

    // First is condensed → stubbed
    const condensedContent = (
      toolResultEntries[0].message as { content: Array<{ content: string }> }
    ).content[0].content;
    expect(condensedContent).toContain("[COMPACTION STUB");
    expect(condensedContent).toContain("ambix query orig-sess");
    expect(condensedContent).not.toContain("AAA");

    // Second is preserved → passes through
    const preservedContent = (
      toolResultEntries[1].message as { content: Array<{ content: unknown }> }
    ).content[0].content;
    expect(preservedContent).toContain("BBB");
    expect(String(preservedContent)).not.toContain("COMPACTION STUB");

    expect(stats.stubbedToolResultCount).toBe(1);
    expect(stats.bytesSaved).toBeGreaterThan(0);
  });

  it("--full-recent 0 — everything condensed, divider at end", async () => {
    const entries = await loadSession(
      joinLines(userLine({ text: "1", uuid: "a" }), assistantLine({ text: "2", uuid: "b" }))
    );

    const { entries: out, stats } = emit({
      ...baseEmit,
      sourceEntries: entries,
      fullRecent: 0,
      uuidFn: makeUuidFn(),
    });

    expect(out).toHaveLength(3); // 2 entries + divider
    expect(out[0].type).toBe("user");
    expect(out[1].type).toBe("assistant");
    expect((out[2].message as { content?: string }).content).toContain("ambix-compaction-marker"); // divider at the end
    expect(stats.condensedEntryCount).toBe(2);
    expect(stats.preservedEntryCount).toBe(0);
  });

  it("--full-recent > roundCount — everything preserved, divider at start", async () => {
    const entries = await loadSession(
      joinLines(userLine({ text: "only", uuid: "a" }), assistantLine({ text: "reply", uuid: "b" }))
    );

    const { entries: out, stats } = emit({
      ...baseEmit,
      sourceEntries: entries,
      fullRecent: 100,
      uuidFn: makeUuidFn(),
    });

    expect(out).toHaveLength(3); // divider + 2 entries
    expect((out[0].message as { content?: string }).content).toContain("ambix-compaction-marker"); // divider at start
    expect((out[0] as { parentUuid: string | null }).parentUuid).toBeNull();
    expect(out[1].type).toBe("user");
    expect(out[2].type).toBe("assistant");
    expect(stats.condensedEntryCount).toBe(0);
    expect(stats.preservedEntryCount).toBe(2);
  });

  it("stub references the tool_result's own source ix (so `ambix query` returns the result body, not the tool_use)", async () => {
    // Layout: tool_use at source ix=3, tool_result at source ix=4.
    // The stub sits in the tool_result entry → should reference ix=4.
    const entries = await loadSession(
      joinLines(
        userLine({ text: "lead-in", uuid: "pad1" }),
        assistantLine({ text: "ack", uuid: "pad2" }),
        userLine({ text: "do the thing", uuid: "u1" }),
        toolUseAssistantLine({
          name: "Bash",
          input: { command: "echo hi" },
          toolUseId: "tu_X",
          uuid: "a1",
        }),
        toolResultUserLine({ toolUseId: "tu_X", content: "hi", uuid: "r1" }),
        // Round containing the preserved tail
        userLine({ text: "later", uuid: "u2" }),
        assistantLine({ text: "ok", uuid: "a2" })
      )
    );

    const { entries: out } = emit({
      ...baseEmit,
      sourceEntries: entries,
      fullRecent: 1,
      uuidFn: makeUuidFn(),
    });

    const stubbed = out.find((e) => {
      const msg = (e as { message?: { content?: unknown } }).message;
      if (!msg?.content || !Array.isArray(msg.content)) return false;
      const blk = (msg.content as Array<{ type?: string; content?: string }>)[0];
      return (
        blk?.type === "tool_result" &&
        typeof blk.content === "string" &&
        blk.content.includes("COMPACTION STUB")
      );
    });
    expect(stubbed).toBeDefined();
    const stubText = (stubbed!.message as { content: Array<{ content: string }> }).content[0]
      .content;
    // tool_result is at source ix=4 (tool_use at ix=3); stub must reference ix=4
    // so `ambix query` resolves to the result body rather than the call itself.
    expect(stubText).toMatch(/ambix query orig-sess 4/);
  });

  it("regenerates promptId, requestId, and message.id so no source-session routing IDs leak through", async () => {
    const entries = await loadSession(
      joinLines(
        userLine({ text: "hi", uuid: "u1" }),
        assistantLine({
          text: "hello",
          uuid: "a1",
          requestId: "req_SOURCE_REQUEST_ID_SHOULD_NOT_LEAK",
        })
      )
    );

    // Capture the source-side routing ID values before emit.
    const sourceUser = entries[0] as Record<string, unknown>;
    const sourceAsst = entries[1] as Record<string, unknown>;
    const sourcePromptId = sourceUser.promptId as string | undefined;
    const sourceRequestId = sourceAsst.requestId as string | undefined;
    const sourceMsgId = ((sourceAsst.message as Record<string, unknown>)?.id as string) ?? "";

    const { entries: out } = emit({
      ...baseEmit,
      sourceEntries: entries,
      fullRecent: 10,
      uuidFn: makeUuidFn(),
    });

    // No emitted entry carries the source-session routing IDs.
    for (const e of out) {
      const rec = e as Record<string, unknown>;
      if (sourcePromptId) expect(rec.promptId).not.toBe(sourcePromptId);
      if (sourceRequestId) expect(rec.requestId).not.toBe(sourceRequestId);
      const mId = (rec.message as Record<string, unknown> | undefined)?.id;
      if (sourceMsgId && mId) expect(mId).not.toBe(sourceMsgId);

      // When present, the fresh values match the expected format prefixes.
      if (typeof rec.requestId === "string") {
        expect(rec.requestId.startsWith("req_")).toBe(true);
      }
      if (mId && typeof mId === "string") {
        expect(mId.startsWith("msg_")).toBe(true);
      }
    }
  });

  it("truncates oversized string fields inside condensed tool_use.input (Edit old_string, etc.)", async () => {
    const bigOld = "x".repeat(2000);
    const bigNew = "y".repeat(2000);
    const entries = await loadSession(
      joinLines(
        userLine({ text: "edit a file", uuid: "u1" }),
        toolUseAssistantLine({
          name: "Edit",
          input: { file_path: "/tmp/f.ts", old_string: bigOld, new_string: bigNew },
          toolUseId: "tu_E",
          uuid: "a1",
        }),
        toolResultUserLine({ toolUseId: "tu_E", content: "ok", uuid: "r1" }),
        // Round 2 — preserved, big strings must NOT be truncated here
        userLine({ text: "edit again", uuid: "u2" }),
        toolUseAssistantLine({
          name: "Edit",
          input: {
            file_path: "/tmp/g.ts",
            old_string: "z".repeat(2000),
            new_string: "q".repeat(2000),
          },
          toolUseId: "tu_E2",
          uuid: "a2",
        }),
        toolResultUserLine({ toolUseId: "tu_E2", content: "ok", uuid: "r2" })
      )
    );

    const { entries: out, stats } = emit({
      ...baseEmit,
      sourceEntries: entries,
      fullRecent: 1,
      uuidFn: makeUuidFn(),
    });

    // Condensed round's tool_use input — big fields truncated, small ones kept
    const condensedAsst = out[1] as Record<string, unknown>;
    const condensedInput = (
      condensedAsst.message as { content: Array<{ input?: Record<string, unknown> }> }
    ).content[0].input!;
    expect(condensedInput.file_path).toBe("/tmp/f.ts"); // short: preserved
    expect(condensedInput.old_string).toMatch(/COMPACTION STUB/);
    expect(condensedInput.new_string).toMatch(/COMPACTION STUB/);
    expect(String(condensedInput.old_string)).toContain("ambix query");

    // Preserved round's tool_use input — big fields passed through verbatim
    const preservedAsst = out.find((e, i) => {
      if (i < 3) return false;
      const msg = (e as { message?: { content?: unknown } }).message;
      if (!msg?.content || !Array.isArray(msg.content)) return false;
      const b = (msg.content as Array<{ type?: string; input?: Record<string, unknown> }>)[0];
      return b?.type === "tool_use" && b?.input?.file_path === "/tmp/g.ts";
    });
    expect(preservedAsst).toBeDefined();
    const preservedInput = (
      preservedAsst!.message as { content: Array<{ input: Record<string, unknown> }> }
    ).content[0].input;
    expect(preservedInput.old_string).toBe("z".repeat(2000));
    expect(preservedInput.new_string).toBe("q".repeat(2000));

    expect(stats.truncatedInputFieldCount).toBe(2); // condensed old_string + new_string
    expect(stats.bytesSaved).toBeGreaterThan(3000); // roughly 2×2000 bytes minus marker overhead
  });

  it("empty source — just emits a divider with preservedFirstIx past end", () => {
    const { entries: out, stats } = emit({
      ...baseEmit,
      sourceEntries: [],
      fullRecent: 10,
      uuidFn: makeUuidFn(),
    });

    expect(out).toHaveLength(1);
    expect((out[0].message as { content?: string }).content).toContain("ambix-compaction-marker");
    expect(stats.sourceEntryCount).toBe(0);
    expect(stats.condensedEntryCount).toBe(0);
    expect(stats.preservedEntryCount).toBe(0);
  });
});
