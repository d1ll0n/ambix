import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupTmpWorkspace, makeTmpWorkspace } from "../../src/orchestrate/tmp.js";
import { cleanupTempDir, makeTempDir } from "../helpers/fixtures.js";

describe("tmp lifecycle helpers", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("makeTmpWorkspace creates a unique directory under the given root", async () => {
    const a = await makeTmpWorkspace({ root: dir, sessionId: "sess-1" });
    const b = await makeTmpWorkspace({ root: dir, sessionId: "sess-1" });
    expect(a).not.toBe(b);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(a.startsWith(dir)).toBe(true);
    expect(b.startsWith(dir)).toBe(true);
  });

  it("cleanupTmpWorkspace deletes the directory when keep=false", async () => {
    const tmp = await makeTmpWorkspace({ root: dir, sessionId: "sess-1" });
    mkdirSync(path.join(tmp, "sub"));
    writeFileSync(path.join(tmp, "sub", "file.txt"), "hi");

    await cleanupTmpWorkspace(tmp, { keep: false });
    expect(existsSync(tmp)).toBe(false);
  });

  it("cleanupTmpWorkspace preserves the directory when keep=true", async () => {
    const tmp = await makeTmpWorkspace({ root: dir, sessionId: "sess-1" });
    writeFileSync(path.join(tmp, "file.txt"), "hi");
    await cleanupTmpWorkspace(tmp, { keep: true });
    expect(existsSync(tmp)).toBe(true);
  });
});
