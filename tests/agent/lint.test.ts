import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { lintNarrative } from "../../src/agent/lint.js";
import { makeTempDir, cleanupTempDir } from "../helpers/fixtures.js";
import type { Narrative } from "../../src/artifact/types.js";

function minimalValidNarrative(): Narrative {
  return {
    summary: "Session did the thing.",
    main_tasks: [
      { title: "Do the thing", status: "completed", description: "...", refs: [0] },
    ],
    episodes: [
      { title: "Start", kind: "implementation", ix_range: [0, 1], summary: "...", refs: [0, 1] },
    ],
    decisions: [],
    corrections: [],
    verification: { was_verified: true, how: "tests pass", refs: [1] },
    friction_points: [],
    wins: [],
    unresolved: [],
  };
}

function setupTmp(dir: string, sessionLines: number, narrative: unknown): void {
  mkdirSync(path.join(dir, "out"), { recursive: true });
  writeFileSync(path.join(dir, "out", "narrative.json"), JSON.stringify(narrative));
  const lines: string[] = [];
  for (let i = 0; i < sessionLines; i++) {
    lines.push(JSON.stringify({ ix: i, ref: `uuid:${i}`, role: "user", type: "user", ts: null, content: `turn ${i}` }));
  }
  writeFileSync(path.join(dir, "session.jsonl"), lines.join("\n") + "\n");
}

describe("lintNarrative", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("returns empty errors for a minimally valid narrative", async () => {
    setupTmp(dir, 2, minimalValidNarrative());
    const errors = await lintNarrative(dir);
    expect(errors).toEqual([]);
  });

  it("errors when out/narrative.json does not exist", async () => {
    mkdirSync(path.join(dir, "out"), { recursive: true });
    const lines = [JSON.stringify({ ix: 0, ref: "uuid:0", role: "user", type: "user", ts: null, content: "x" })];
    writeFileSync(path.join(dir, "session.jsonl"), lines.join("\n") + "\n");
    const errors = await lintNarrative(dir);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.some((e) => /narrative\.json/.test(e))).toBe(true);
  });

  it("errors when session.jsonl does not exist", async () => {
    mkdirSync(path.join(dir, "out"), { recursive: true });
    writeFileSync(path.join(dir, "out", "narrative.json"), JSON.stringify(minimalValidNarrative()));
    const errors = await lintNarrative(dir);
    expect(errors.some((e) => /session\.jsonl/.test(e))).toBe(true);
  });

  it("errors when narrative is missing required top-level fields", async () => {
    const broken = { summary: "x" } as unknown;
    setupTmp(dir, 2, broken);
    const errors = await lintNarrative(dir);
    expect(errors.some((e) => /main_tasks/.test(e))).toBe(true);
    expect(errors.some((e) => /episodes/.test(e))).toBe(true);
    expect(errors.some((e) => /verification/.test(e))).toBe(true);
  });

  it("errors when refs point at invalid ix values", async () => {
    const n = minimalValidNarrative();
    n.main_tasks[0].refs = [99];
    setupTmp(dir, 2, n);
    const errors = await lintNarrative(dir);
    expect(errors.some((e) => /ref.*99/.test(e))).toBe(true);
  });

  it("errors when episode ix_range is inverted or out of range", async () => {
    const n = minimalValidNarrative();
    n.episodes[0].ix_range = [5, 2];
    setupTmp(dir, 2, n);
    let errors = await lintNarrative(dir);
    expect(errors.some((e) => /ix_range/.test(e))).toBe(true);

    n.episodes[0].ix_range = [0, 99];
    setupTmp(dir, 2, n);
    errors = await lintNarrative(dir);
    expect(errors.some((e) => /ix_range/.test(e))).toBe(true);
  });

  it("errors when enum fields have invalid values", async () => {
    const n = minimalValidNarrative();
    (n.main_tasks[0] as unknown as { status: string }).status = "not_a_real_status";
    setupTmp(dir, 2, n);
    const errors = await lintNarrative(dir);
    expect(errors.some((e) => /status/.test(e))).toBe(true);
  });

  it("errors when summary is empty", async () => {
    const n = minimalValidNarrative();
    n.summary = "";
    setupTmp(dir, 2, n);
    const errors = await lintNarrative(dir);
    expect(errors.some((e) => /summary/.test(e))).toBe(true);
  });

  it("accepts friction_points with an attribution field", async () => {
    const n = minimalValidNarrative();
    n.friction_points = [
      { description: "agent kept rediscovering X", refs: [0], attribution: "user memory candidate" },
    ];
    setupTmp(dir, 2, n);
    const errors = await lintNarrative(dir);
    expect(errors).toEqual([]);
  });
});
