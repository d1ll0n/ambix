import { describe, expect, it } from "vitest";
import { buildSummaryEntry } from "../../../../src/compact-session/_experimental/structural/summary.js";

const baseOpts = {
  origSessionId: "orig-123",
  newSessionId: "new-456",
  parentUuid: "prev-uuid",
  cwd: "/work/proj",
  gitBranch: "main",
  version: "2.1.110",
  lastSourceIx: 99,
  fullRecent: 10,
  now: "2026-04-17T12:00:00.000Z",
  uuid: "summary-uuid",
  promptId: "prompt-uuid",
};

describe("buildSummaryEntry", () => {
  it("emits a plain user entry (not isCompactSummary) with the expected base fields", () => {
    const e = buildSummaryEntry({
      ...baseOpts,
      condensedLastIx: 80,
      preservedFirstIx: 81,
    });

    expect(e.type).toBe("user");
    // Deliberately NOT set: isCompactSummary / isVisibleInTranscriptOnly would
    // cause CC to hide pre-divider entries from the model — see summary.ts.
    expect(e.isCompactSummary).toBeUndefined();
    expect(e.isVisibleInTranscriptOnly).toBeUndefined();
    expect(e.isSidechain).toBe(false);
    expect(e.uuid).toBe("summary-uuid");
    expect(e.parentUuid).toBe("prev-uuid");
    expect(e.sessionId).toBe("new-456");
    expect(e.timestamp).toBe("2026-04-17T12:00:00.000Z");
    expect(e.userType).toBe("external");
    expect(e.entrypoint).toBe("cli");
    expect(e.cwd).toBe("/work/proj");
    expect(e.gitBranch).toBe("main");
    expect(e.version).toBe("2.1.110");
    expect(e.promptId).toBe("prompt-uuid");
    const msg = e.message as { role: string; content: string };
    expect(msg.role).toBe("user");
    // Content is wrapped in an <ambix-compaction-marker> tag so the model
    // can recognize it as structural metadata rather than a user turn.
    expect(msg.content).toContain("<ambix-compaction-marker>");
    expect(msg.content).toContain("</ambix-compaction-marker>");
  });

  it("normal split — content describes both condensed and preserved sections", () => {
    const e = buildSummaryEntry({
      ...baseOpts,
      condensedLastIx: 80,
      preservedFirstIx: 81,
    });
    const content = (e.message as { content: string }).content;

    expect(content).toContain("compacted by ambix from orig-123");
    expect(content).toContain("turns 0–80");
    expect(content).toContain("COMPACTION STUBS");
    expect(content).toContain("turns 81–99");
    expect(content).toContain("last 10 rounds");
    expect(content).toContain("ambix query");
    expect(content).toContain("Do NOT infer or guess");
  });

  it("empty condensed section — content says full source fits within preserved window", () => {
    const e = buildSummaryEntry({
      ...baseOpts,
      condensedLastIx: -1, // no condensed
      preservedFirstIx: 0,
    });
    const content = (e.message as { content: string }).content;

    expect(content).toContain("No turns are condensed in this file");
    expect(content).not.toContain("turns 0–-1");
    expect(content).toContain("turns 0–99");
  });

  it("empty preserved section (--full-recent 0) — content notes no preserved turns", () => {
    const e = buildSummaryEntry({
      ...baseOpts,
      condensedLastIx: 99,
      preservedFirstIx: 100, // past end
      fullRecent: 0,
    });
    const content = (e.message as { content: string }).content;

    expect(content).toContain("turns 0–99");
    expect(content).toContain("No turns preserved verbatim");
    expect(content).toContain("--full-recent 0");
  });

  it("generates fresh uuid/promptId/timestamp when not overridden", () => {
    const e1 = buildSummaryEntry({
      ...baseOpts,
      uuid: undefined,
      promptId: undefined,
      now: undefined,
      condensedLastIx: 5,
      preservedFirstIx: 6,
    });
    const e2 = buildSummaryEntry({
      ...baseOpts,
      uuid: undefined,
      promptId: undefined,
      now: undefined,
      condensedLastIx: 5,
      preservedFirstIx: 6,
    });

    expect(e1.uuid).not.toBe(e2.uuid);
    expect(e1.promptId).not.toBe(e2.promptId);
    expect(typeof e1.uuid).toBe("string");
    expect((e1.uuid as string).length).toBeGreaterThan(10);
  });
});
