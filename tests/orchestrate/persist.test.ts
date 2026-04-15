import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Artifact } from "../../src/artifact/types.js";
import { persistArtifact } from "../../src/orchestrate/persist.js";
import { cleanupTempDir, makeTempDir } from "../helpers/fixtures.js";

function mockArtifact(): Artifact {
  return {
    schema_version: "1",
    session_id: "sess-1",
    generated_at: "2026-04-13T10:00:00Z",
    metadata: {
      session_id: "sess-1",
      source_path: "/x",
      version: null,
      cwd: null,
      git_branch: null,
      permission_mode: null,
      start_ts: null,
      end_ts: null,
      duration_s: null,
      turn_count: 1,
      end_state: "completed",
    },
    deterministic: {
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
    },
    narrative: {
      summary: "x",
      main_tasks: [],
      episodes: [],
      decisions: [],
      corrections: [],
      verification: { was_verified: false, how: "", refs: [] },
      friction_points: [],
      wins: [],
      unresolved: [],
    },
  };
}

describe("persistArtifact", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("writes the artifact to <outputRoot>/sessions/<session-id>/artifact.json", async () => {
    const outputRoot = path.join(dir, "alembic-home");
    const artifact = mockArtifact();
    const written = await persistArtifact(artifact, { outputRoot });

    const expected = path.join(outputRoot, "sessions", "sess-1", "artifact.json");
    expect(written).toBe(expected);
    expect(existsSync(expected)).toBe(true);

    const content = JSON.parse(readFileSync(expected, "utf8")) as Artifact;
    expect(content.session_id).toBe("sess-1");
  });

  it("creates parent directories if they do not exist", async () => {
    const outputRoot = path.join(dir, "deeply", "nested");
    const artifact = mockArtifact();
    const written = await persistArtifact(artifact, { outputRoot });
    expect(existsSync(written)).toBe(true);
  });

  it("overwrites an existing artifact file", async () => {
    const outputRoot = path.join(dir, "alembic-home");
    await persistArtifact(mockArtifact(), { outputRoot });
    const updated = mockArtifact();
    updated.narrative.summary = "updated";
    const written = await persistArtifact(updated, { outputRoot });
    const content = JSON.parse(readFileSync(written, "utf8")) as Artifact;
    expect(content.narrative.summary).toBe("updated");
  });
});
