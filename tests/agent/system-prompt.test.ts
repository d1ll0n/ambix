import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../../src/agent/system-prompt.js";

describe("buildSystemPrompt", () => {
  it("includes role, goal, and verification requirement", () => {
    const prompt = buildSystemPrompt({ tmpDir: "/tmp/alembic-x" });
    expect(prompt).toContain("session distiller");
    expect(prompt).toContain("out/narrative.json");
    expect(prompt).toContain("bin/lint-output");
  });

  it("mentions the key input files", () => {
    const prompt = buildSystemPrompt({ tmpDir: "/tmp/alembic-x" });
    expect(prompt).toContain("metadata.json");
    expect(prompt).toContain("session.jsonl");
    expect(prompt).toContain("turns/");
    expect(prompt).toContain("spill/");
    expect(prompt).toContain("subagents/");
    expect(prompt).toContain("file-history/");
  });

  it("mentions the file-at CLI", () => {
    const prompt = buildSystemPrompt({ tmpDir: "/tmp/alembic-x" });
    expect(prompt).toContain("file-at");
  });

  it("documents the narrative schema fields", () => {
    const prompt = buildSystemPrompt({ tmpDir: "/tmp/alembic-x" });
    expect(prompt).toContain("summary");
    expect(prompt).toContain("main_tasks");
    expect(prompt).toContain("episodes");
    expect(prompt).toContain("friction_points");
    expect(prompt).toContain("attribution");
  });

  it("explains cost-aware rehydration behavior", () => {
    const prompt = buildSystemPrompt({ tmpDir: "/tmp/alembic-x" });
    expect(prompt).toMatch(/rehydrat/i);
    expect(prompt).toMatch(/tokens_est/);
  });
});
