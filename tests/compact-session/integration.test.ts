import { readFileSync } from "node:fs";
import path from "node:path";
import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactSession } from "../../src/compact-session/index.js";
import { sessionInfo } from "../../src/info/index.js";
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

describe("compactSession — integration (round-trip through parse-cc + info)", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("compacts a realistic tool_use session and the output survives re-parse + ambix info", async () => {
    const source = writeFixture(
      dir,
      "source.jsonl",
      joinLines(
        // Round 1 — condensed (Read with big body)
        userLine({ text: "inspect src/foo.ts", uuid: "u1", cwd: "/work" }),
        toolUseAssistantLine({
          name: "Read",
          input: { file_path: "/work/src/foo.ts" },
          toolUseId: "tu_READ_1",
          uuid: "a1",
          inputTokens: 20,
          outputTokens: 40,
        }),
        toolResultUserLine({
          toolUseId: "tu_READ_1",
          content: "export const x = 1;\n".repeat(50), // ~1000 bytes
          uuid: "r1",
        }),
        assistantLine({ text: "Inspected; mostly exports.", uuid: "a2" }),
        // Round 2 — preserved verbatim
        userLine({ text: "now run the tests", uuid: "u2", cwd: "/work" }),
        toolUseAssistantLine({
          name: "Bash",
          input: { command: "npm test" },
          toolUseId: "tu_BASH_1",
          uuid: "a3",
          inputTokens: 15,
          outputTokens: 25,
        }),
        toolResultUserLine({
          toolUseId: "tu_BASH_1",
          content: "3 passing (120ms)\n",
          uuid: "r2",
        }),
        assistantLine({ text: "Tests green.", uuid: "a4" })
      )
    );

    const output = path.join(dir, "compacted.jsonl");
    // Structural mode: this test inspects the per-entry shape of tool_results
    // (preserved round_2 keeps its body, condensed round_1 has a stub). Bundled
    // mode collapses those into a single prose message — different contract,
    // covered separately.
    const result = await compactSession(new Session(source), {
      mode: "structural",
      fullRecent: 1,
      output,
    });

    // Stats sanity
    expect(result.stats.sourceEntryCount).toBe(8);
    expect(result.stats.stubbedToolResultCount).toBe(1); // only round 1's tool_result
    expect(result.stats.bytesSaved).toBeGreaterThan(500);

    // Round-trip: parse-cc can load the output cleanly
    const compacted = new Session(output);
    const entries = await compacted.messages();
    expect(entries.length).toBeGreaterThan(0);
    expect(compacted.sessionId).toBe(result.newSessionId);

    // The file contains exactly one isCompactSummary line
    const rawLines = readFileSync(output, "utf8").trim().split("\n");
    const summaryLines = rawLines.filter((l) => l.includes("<ambix-compaction-marker>"));
    expect(summaryLines).toHaveLength(1);

    // ambix info runs cleanly against the compacted session
    const info = await sessionInfo(compacted);
    expect(info.metadata.session_id).toBe(result.newSessionId);
    expect(info.metadata.end_state).toBe("completed"); // has assistant entries
    expect(info.metadata.turn_count).toBeGreaterThan(0);

    // Preserved tool_result retained its content (round 2's "3 passing")
    const preservedTr = entries.find((e) => {
      const msg = (e as { message?: { content?: unknown } }).message;
      if (!Array.isArray(msg?.content)) return false;
      const c = msg.content as Array<{ type?: string; content?: string }>;
      return (
        c[0]?.type === "tool_result" &&
        typeof c[0].content === "string" &&
        c[0].content.includes("3 passing")
      );
    });
    expect(preservedTr).toBeDefined();

    // Condensed tool_result has stub, not original body
    const stubbedTr = entries.find((e) => {
      const msg = (e as { message?: { content?: unknown } }).message;
      if (!Array.isArray(msg?.content)) return false;
      const c = msg.content as Array<{ type?: string; content?: string }>;
      return (
        c[0]?.type === "tool_result" &&
        typeof c[0].content === "string" &&
        c[0].content.includes("COMPACTION STUB")
      );
    });
    expect(stubbedTr).toBeDefined();
    const stubContent = (stubbedTr!.message as { content: Array<{ content: string }> }).content[0]
      .content;
    expect(stubContent).toContain("Read");
    expect(stubContent).toContain("ambix query");
    expect(stubContent).not.toContain("export const x");
  });
});
