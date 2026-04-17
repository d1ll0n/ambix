import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Session, listTasks } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactSession } from "../../src/compact-session/index.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("compactSession", () => {
  let dir: string;
  let tasksBaseDir: string;
  beforeEach(() => {
    dir = makeTempDir();
    // Isolated tasks root so tests never touch ~/.claude/tasks.
    tasksBaseDir = path.join(dir, "tasks");
    mkdirSync(tasksBaseDir, { recursive: true });
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("writes a JSONL whose entries round-trip through parse-cc with new sessionId", async () => {
    const source = writeFixture(
      dir,
      "source.jsonl",
      joinLines(
        userLine({ text: "one", uuid: "a", cwd: "/work" }),
        assistantLine({ text: "two", uuid: "b" }),
        userLine({ text: "three", uuid: "c", cwd: "/work" }),
        assistantLine({ text: "four", uuid: "d" })
      )
    );
    const srcSession = new Session(source);
    const output = path.join(dir, "compacted.jsonl");

    const result = await compactSession(srcSession, { fullRecent: 1, output, tasksBaseDir });

    expect(result.dryRun).toBe(false);
    expect(result.destPath).toBe(output);
    expect(result.newSessionId).not.toBe("session-test");
    expect(existsSync(output)).toBe(true);

    // Round-trip the compacted file
    const compacted = new Session(output);
    const entries = await compacted.messages();
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.sessionId).toBe(result.newSessionId);
    }
    expect(compacted.sessionId).toBe(result.newSessionId);
  });

  it("dryRun=true skips the write and reports it via result.dryRun", async () => {
    const source = writeFixture(
      dir,
      "source.jsonl",
      joinLines(userLine({ text: "hi", uuid: "a", cwd: "/work" }))
    );
    const output = path.join(dir, "should-not-exist.jsonl");

    const result = await compactSession(new Session(source), {
      fullRecent: 10,
      output,
      dryRun: true,
      tasksBaseDir,
    });

    expect(result.dryRun).toBe(true);
    expect(result.copiedTasksDir).toBeNull();
    expect(existsSync(output)).toBe(false);
    expect(result.stats.sourceEntryCount).toBe(1);
  });

  it("default output path lands under ~/.claude/projects/<slug>/<new-uuid>.jsonl", async () => {
    // We don't actually write — the real homedir isn't ours to pollute in tests.
    const source = writeFixture(
      dir,
      "source.jsonl",
      joinLines(userLine({ text: "hi", uuid: "a", cwd: "/specific-test-cwd" }))
    );

    const result = await compactSession(new Session(source), {
      fullRecent: 10,
      dryRun: true,
      tasksBaseDir,
    });

    // Slug comes from cwd with / → - substitution; same convention as CC + distiller-log-capture.
    expect(result.destPath).toMatch(/\/\.claude\/projects\/-specific-test-cwd\/[0-9a-f-]+\.jsonl$/);
  });

  it("structural mode: carries the condensed/preserved split described by --fullRecent into stats", async () => {
    const source = writeFixture(
      dir,
      "source.jsonl",
      joinLines(
        userLine({ text: "r1", uuid: "a", cwd: "/work" }),
        assistantLine({ text: "r1-reply", uuid: "b" }),
        userLine({ text: "r2", uuid: "c", cwd: "/work" }),
        assistantLine({ text: "r2-reply", uuid: "d" }),
        userLine({ text: "r3", uuid: "e", cwd: "/work" }),
        assistantLine({ text: "r3-reply", uuid: "f" })
      )
    );
    const output = path.join(dir, "compacted.jsonl");

    const result = await compactSession(new Session(source), {
      mode: "structural",
      fullRecent: 1,
      output,
      tasksBaseDir,
    });

    expect(result.stats.sourceEntryCount).toBe(6);
    expect(result.stats.condensedEntryCount).toBe(4); // rounds 1 + 2
    expect(result.stats.preservedEntryCount).toBe(2); // round 3

    // Verify the written file contains exactly one isCompactSummary entry
    const rawLines = readFileSync(output, "utf8").trim().split("\n");
    const summaryLines = rawLines.filter((l) => l.includes("<ambix-compaction-marker>"));
    expect(summaryLines).toHaveLength(1);
  });

  it("snapshots the source's tasks dir into the new session (copy, not symlink)", async () => {
    // Write a source session whose sessionId has a corresponding tasks dir.
    const source = writeFixture(
      dir,
      "source.jsonl",
      joinLines(
        userLine({ text: "one", uuid: "a", cwd: "/work", sessionId: "orig-with-tasks" }),
        assistantLine({ text: "two", uuid: "b", sessionId: "orig-with-tasks" })
      )
    );
    // Seed a couple of tasks for the source.
    mkdirSync(path.join(tasksBaseDir, "orig-with-tasks"), { recursive: true });
    writeFileSync(
      path.join(tasksBaseDir, "orig-with-tasks", "1.json"),
      JSON.stringify({
        id: "1",
        subject: "pending thing",
        description: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      })
    );

    const output = path.join(dir, "compacted.jsonl");
    const result = await compactSession(new Session(source), {
      fullRecent: 1,
      output,
      tasksBaseDir,
    });

    expect(result.copiedTasksDir).toBe(path.join(tasksBaseDir, result.newSessionId));
    // It's a real directory, not a symlink
    expect(lstatSync(result.copiedTasksDir!).isDirectory()).toBe(true);
    expect(lstatSync(result.copiedTasksDir!).isSymbolicLink()).toBe(false);

    // listTasks reads the copied tasks.
    const tasks = await listTasks(result.newSessionId, tasksBaseDir);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].subject).toBe("pending thing");

    // Mutations on the source's tasks AFTER copy don't leak into the new session.
    writeFileSync(
      path.join(tasksBaseDir, "orig-with-tasks", "2.json"),
      JSON.stringify({
        id: "2",
        subject: "added after compact",
        description: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      })
    );
    const newTasksAfterSourceMutation = await listTasks(result.newSessionId, tasksBaseDir);
    expect(newTasksAfterSourceMutation).toHaveLength(1);
  });

  it("refuses to overwrite --output if the path already exists", async () => {
    const source = writeFixture(
      dir,
      "source.jsonl",
      joinLines(userLine({ text: "hi", uuid: "a", cwd: "/work", sessionId: "s" }))
    );
    const output = path.join(dir, "already-there.jsonl");
    writeFileSync(output, "previous content");

    await expect(
      compactSession(new Session(source), { fullRecent: 10, output, tasksBaseDir })
    ).rejects.toThrow(/--output path already exists/);

    // The pre-existing file is untouched.
    expect(readFileSync(output, "utf8")).toBe("previous content");
  });

  it("copiedTasksDir is null when source has no tasks dir", async () => {
    const source = writeFixture(
      dir,
      "source.jsonl",
      joinLines(userLine({ text: "hi", uuid: "a", cwd: "/work", sessionId: "no-tasks" }))
    );
    const output = path.join(dir, "compacted.jsonl");

    const result = await compactSession(new Session(source), {
      fullRecent: 10,
      output,
      tasksBaseDir,
    });

    expect(result.copiedTasksDir).toBeNull();
    expect(existsSync(path.join(tasksBaseDir, result.newSessionId))).toBe(false);
  });
});
