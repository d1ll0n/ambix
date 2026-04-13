import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Session } from "parse-claude-logs";
import { clusterBashCommands } from "../../src/analyze/bash-clusters.js";
import {
  makeTempDir,
  cleanupTempDir,
  writeFixture,
  joinLines,
  toolUseAssistantLine,
} from "../helpers/fixtures.js";

describe("clusterBashCommands", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("groups Bash invocations by first token", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Bash", input: { command: "git log --oneline -n 5" } }),
      toolUseAssistantLine({ name: "Bash", input: { command: "git status" } }),
      toolUseAssistantLine({ name: "Bash", input: { command: "git diff HEAD~1" } }),
      toolUseAssistantLine({ name: "Bash", input: { command: "ls -la" } }),
      toolUseAssistantLine({ name: "Bash", input: { command: "ls /tmp" } })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const clusters = clusterBashCommands(entries);

    const git = clusters.find((c) => c.pattern === "git")!;
    expect(git.count).toBe(3);
    expect(git.examples_ix.length).toBeGreaterThan(0);

    const ls = clusters.find((c) => c.pattern === "ls")!;
    expect(ls.count).toBe(2);
  });

  it("ignores non-Bash tool_use blocks", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Read", input: { file_path: "a.ts" } }),
      toolUseAssistantLine({ name: "Bash", input: { command: "echo hi" } })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const clusters = clusterBashCommands(entries);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].pattern).toBe("echo");
    expect(clusters[0].count).toBe(1);
  });

  it("records the ix of each occurrence, capped at 5 examples per cluster", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 8; i++) {
      lines.push(toolUseAssistantLine({ name: "Bash", input: { command: `grep pattern${i} file.ts` } }));
    }
    const text = joinLines(...lines);
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const clusters = clusterBashCommands(entries);
    const grep = clusters.find((c) => c.pattern === "grep")!;
    expect(grep.count).toBe(8);
    expect(grep.examples_ix.length).toBeLessThanOrEqual(5);
  });

  it("handles commands with leading whitespace or env prefixes", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Bash", input: { command: "  ls -la" } }),
      toolUseAssistantLine({ name: "Bash", input: { command: "DEBUG=1 ls" } })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const clusters = clusterBashCommands(entries);
    expect(clusters.find((c) => c.pattern === "ls")?.count).toBe(1);
    expect(clusters.find((c) => c.pattern === "DEBUG=1")?.count).toBe(1);
  });

  it("returns empty array when there are no Bash calls", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Read", input: { file_path: "a.ts" } })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    expect(clusterBashCommands(entries)).toEqual([]);
  });
});
