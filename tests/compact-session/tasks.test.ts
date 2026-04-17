import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { listTasks } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyTasksDir } from "../../src/compact-session/tasks.js";
import { cleanupTempDir, makeTempDir } from "../helpers/fixtures.js";

describe("copyTasksDir", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  function writeTask(
    tasksBaseDir: string,
    sessionId: string,
    task: { id: string; subject: string; status: string }
  ): void {
    const sessDir = path.join(tasksBaseDir, sessionId);
    mkdirSync(sessDir, { recursive: true });
    writeFileSync(
      path.join(sessDir, `${task.id}.json`),
      JSON.stringify({ ...task, description: "", blocks: [], blockedBy: [] })
    );
  }

  it("copies the tasks dir from source to new session (not a symlink)", async () => {
    writeTask(dir, "orig", { id: "1", subject: "do thing", status: "pending" });

    const result = await copyTasksDir({
      origSessionId: "orig",
      newSessionId: "new",
      tasksBaseDir: dir,
    });

    expect(result.copiedTo).toBe(path.join(dir, "new"));
    expect(result.source).toBe(path.resolve(path.join(dir, "orig")));
    // It's a real directory, not a symlink
    expect(lstatSync(path.join(dir, "new")).isDirectory()).toBe(true);
    expect(lstatSync(path.join(dir, "new")).isSymbolicLink()).toBe(false);

    // Both sides contain the task
    expect(existsSync(path.join(dir, "orig", "1.json"))).toBe(true);
    expect(existsSync(path.join(dir, "new", "1.json"))).toBe(true);
  });

  it("new session is independent — mutating the source after copy does not leak", async () => {
    writeTask(dir, "orig", { id: "1", subject: "first", status: "pending" });
    writeTask(dir, "orig", { id: "2", subject: "second", status: "in_progress" });

    await copyTasksDir({ origSessionId: "orig", newSessionId: "new", tasksBaseDir: dir });

    // Add a task to the source AFTER the copy
    writeTask(dir, "orig", { id: "3", subject: "added after copy", status: "pending" });

    // New session still sees only the two tasks from copy time
    const newTasks = await listTasks("new", dir);
    expect(newTasks).toHaveLength(2);
    expect(newTasks.map((t) => t.id)).toEqual(["1", "2"]);

    // Source has all three
    const origTasks = await listTasks("orig", dir);
    expect(origTasks).toHaveLength(3);
  });

  it("new session is independent — mutating the new does not leak back to source", async () => {
    writeTask(dir, "orig", { id: "1", subject: "original", status: "pending" });

    const result = await copyTasksDir({
      origSessionId: "orig",
      newSessionId: "new",
      tasksBaseDir: dir,
    });

    // Overwrite the copied task's payload
    writeFileSync(
      path.join(result.copiedTo!, "1.json"),
      JSON.stringify({
        id: "1",
        subject: "updated on new",
        description: "",
        status: "completed",
        blocks: [],
        blockedBy: [],
      })
    );

    // Source's task is untouched
    const origTasks = await listTasks("orig", dir);
    expect(origTasks[0].subject).toBe("original");
    expect(origTasks[0].status).toBe("pending");

    // New session sees the updated version
    const newTasks = await listTasks("new", dir);
    expect(newTasks[0].subject).toBe("updated on new");
    expect(newTasks[0].status).toBe("completed");
  });

  it("no-op when the source has no tasks dir", async () => {
    const result = await copyTasksDir({
      origSessionId: "nothing-here",
      newSessionId: "new",
      tasksBaseDir: dir,
    });

    expect(result.copiedTo).toBeNull();
    expect(result.source).toBeNull();
    expect(existsSync(path.join(dir, "new"))).toBe(false);
  });

  it("copies .highwatermark and task payloads together so IDs stay consistent", async () => {
    const origDir = path.join(dir, "orig");
    mkdirSync(origDir, { recursive: true });
    writeFileSync(path.join(origDir, ".highwatermark"), "5");
    writeFileSync(
      path.join(origDir, "3.json"),
      JSON.stringify({
        id: "3",
        subject: "t",
        description: "",
        status: "pending",
        blocks: [],
        blockedBy: [],
      })
    );

    const result = await copyTasksDir({
      origSessionId: "orig",
      newSessionId: "new",
      tasksBaseDir: dir,
    });

    expect(readFileSync(path.join(result.copiedTo!, ".highwatermark"), "utf8")).toBe("5");
    expect(existsSync(path.join(result.copiedTo!, "3.json"))).toBe(true);
  });

  it("throws rather than overwriting an existing destination", async () => {
    writeTask(dir, "orig", { id: "1", subject: "fresh", status: "pending" });
    // Seed the destination with unrelated data — copyTasksDir refuses to
    // stomp it. The caller owns uniqueness of newSessionId.
    const destDir = path.join(dir, "new");
    mkdirSync(destDir, { recursive: true });
    writeFileSync(path.join(destDir, "stale.json"), "existing state");

    await expect(
      copyTasksDir({ origSessionId: "orig", newSessionId: "new", tasksBaseDir: dir })
    ).rejects.toThrow();

    // Original state is untouched.
    expect(readFileSync(path.join(destDir, "stale.json"), "utf8")).toBe("existing state");
  });
});
