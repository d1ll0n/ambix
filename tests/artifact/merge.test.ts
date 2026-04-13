import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { mergeArtifact } from "../../src/artifact/merge.js";
import { makeTempDir, cleanupTempDir } from "../helpers/fixtures.js";
import type { MetadataJson } from "../../src/types.js";
import type { AnalyzeResult } from "../../src/analyze/index.js";
import type { Narrative } from "../../src/artifact/types.js";

function blankDeterministic(): AnalyzeResult {
  return {
    tokens: { by_model: {}, totals: { in: 0, out: 0, cache_read: 0, cache_write: 0 } },
    tools: { invocations: {} },
    files: { touched: [], read_without_write: [] },
    churn_timeline: [],
    bash_clusters: [],
    failures: [],
    compaction_phases: [],
    subagents: [],
    spill_files: [],
    token_density_timeline: [],
    permission_events: [],
  };
}

function blankMetadata(): MetadataJson {
  return {
    session_id: "sess-1",
    source_path: "/path/to/session.jsonl",
    version: "2.1.97",
    cwd: "/work",
    git_branch: "main",
    permission_mode: "default",
    start_ts: "2026-04-13T10:00:00Z",
    end_ts: "2026-04-13T10:05:00Z",
    duration_s: 300,
    turn_count: 42,
    end_state: "completed",
  };
}

function blankNarrative(): Narrative {
  return {
    summary: "placeholder",
    main_tasks: [],
    episodes: [],
    decisions: [],
    corrections: [],
    verification: { was_verified: false, how: "", refs: [] },
    friction_points: [],
    wins: [],
    unresolved: [],
  };
}

describe("mergeArtifact", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("combines metadata, deterministic, and narrative into a single artifact object", () => {
    const artifact = mergeArtifact({
      metadata: blankMetadata(),
      deterministic: blankDeterministic(),
      narrative: blankNarrative(),
    });

    expect(artifact.schema_version).toBe("1");
    expect(artifact.session_id).toBe("sess-1");
    expect(artifact.metadata.turn_count).toBe(42);
    expect(artifact.deterministic.tokens.totals.in).toBe(0);
    expect(artifact.narrative.summary).toBe("placeholder");
    expect(artifact.generated_at).toBeDefined();
    expect(Number.isNaN(Date.parse(artifact.generated_at))).toBe(false);
  });

  it("reads narrative.json from disk when given a path", async () => {
    mkdirSync(path.join(dir, "out"), { recursive: true });
    writeFileSync(path.join(dir, "out", "narrative.json"), JSON.stringify(blankNarrative()));

    const artifact = await mergeArtifact.fromPaths({
      metadata: blankMetadata(),
      deterministic: blankDeterministic(),
      narrativePath: path.join(dir, "out", "narrative.json"),
    });

    expect(artifact.narrative.summary).toBe("placeholder");
  });
});
