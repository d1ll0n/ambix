import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { resolveSessionPath } from "../../src/orchestrate/resolve.js";
import { makeTempDir, cleanupTempDir, joinLines, userLine } from "../helpers/fixtures.js";

describe("resolveSessionPath", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("passes through an existing absolute file path", async () => {
    const filePath = path.join(dir, "session.jsonl");
    writeFileSync(filePath, joinLines(userLine({ text: "x", sessionId: "sess-1" })));
    const resolved = await resolveSessionPath(filePath);
    expect(resolved).toBe(filePath);
  });

  it("throws a descriptive error when the path does not exist", async () => {
    await expect(resolveSessionPath("/nowhere/missing.jsonl")).rejects.toThrow(/not found/i);
  });
});
