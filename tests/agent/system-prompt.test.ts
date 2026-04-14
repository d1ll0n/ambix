import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { buildSystemPrompt } from "../../src/agent/system-prompt.js";
import { makeTempDir, cleanupTempDir } from "../helpers/fixtures.js";

const MINIMAL_SESSION_LINE = JSON.stringify({
  ix: 0,
  ref: "u:1",
  role: "user",
  type: "user",
  ts: null,
  content: "hi",
});

function setupMinimalLayout(dir: string): void {
  writeFileSync(path.join(dir, "metadata.json"), "{}");
  writeFileSync(path.join(dir, "session.jsonl"), MINIMAL_SESSION_LINE + "\n");
  mkdirSync(path.join(dir, "out"), { recursive: true });
  mkdirSync(path.join(dir, "bin"), { recursive: true });
  writeFileSync(path.join(dir, "bin", "lint-output"), "#!/bin/bash\n");
  writeFileSync(path.join(dir, "bin", "query"), "#!/bin/bash\n");
  writeFileSync(path.join(dir, "bin", "file-at"), "#!/bin/bash\n");
}

describe("buildSystemPrompt", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    setupMinimalLayout(dir);
  });

  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("includes role, goal, and verification requirement", async () => {
    const prompt = await buildSystemPrompt({ tmpDir: dir });
    expect(prompt).toContain("session distiller");
    expect(prompt).toContain("out/narrative.json");
    expect(prompt).toContain("bin/lint-output");
  });

  it("mentions the key input files", async () => {
    const prompt = await buildSystemPrompt({ tmpDir: dir });
    expect(prompt).toContain("metadata.json");
    expect(prompt).toContain("session.jsonl");
    expect(prompt).toContain("turns/");
    expect(prompt).toContain("spill/");
    expect(prompt).toContain("subagents/");
    expect(prompt).toContain("file-history/");
  });

  it("mentions the file-at CLI", async () => {
    const prompt = await buildSystemPrompt({ tmpDir: dir });
    expect(prompt).toContain("file-at");
  });

  it("documents the narrative schema fields", async () => {
    const prompt = await buildSystemPrompt({ tmpDir: dir });
    expect(prompt).toContain("summary");
    expect(prompt).toContain("main_tasks");
    expect(prompt).toContain("episodes");
    expect(prompt).toContain("friction_points");
    expect(prompt).toContain("attribution");
  });

  it("explains cost-aware rehydration behavior", async () => {
    const prompt = await buildSystemPrompt({ tmpDir: dir });
    expect(prompt).toMatch(/rehydrat/i);
    expect(prompt).toMatch(/tokens_est/);
  });

  it("embeds a tree view of the staged tmp dir", async () => {
    // Add a turns dir with one file
    mkdirSync(path.join(dir, "turns"), { recursive: true });
    writeFileSync(path.join(dir, "turns", "00042.json"), "{}");

    const prompt = await buildSystemPrompt({ tmpDir: dir });
    expect(prompt).toContain("session.jsonl");
    expect(prompt).toContain("turns/");
    expect(prompt).toContain("00042.json");
    expect(prompt).toContain("bin/");
    expect(prompt).toContain("lint-output");
  });
});
