import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveSessionPath } from "../../src/orchestrate/resolve.js";
import { cleanupTempDir, joinLines, makeTempDir, userLine } from "../helpers/fixtures.js";

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
