import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileAt } from "../src/file-at.js";
import { makeTempDir, cleanupTempDir } from "./helpers/fixtures.js";
import type { SnapshotsIndex } from "../src/types.js";

describe("fileAt", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  function setupHistory(): void {
    const fhDir = path.join(dir, "file-history");
    mkdirSync(path.join(fhDir, "blobs"), { recursive: true });
    writeFileSync(path.join(fhDir, "blobs", "abc@v1"), "v1 content");
    writeFileSync(path.join(fhDir, "blobs", "abc@v2"), "v2 content");
    writeFileSync(path.join(fhDir, "blobs", "abc@v3"), "v3 content");
    const idx: SnapshotsIndex = {
      files: [
        {
          path: "src/foo.ts",
          versions: [
            { version: 1, ix: 5, backup_time: "t", blob: "blobs/abc@v1", bytes: null },
            { version: 2, ix: 12, backup_time: "t", blob: "blobs/abc@v2", bytes: null },
            { version: 3, ix: 30, backup_time: "t", blob: "blobs/abc@v3", bytes: null },
          ],
        },
      ],
    };
    writeFileSync(path.join(fhDir, "snapshots.json"), JSON.stringify(idx));
  }

  it("returns the version that was current at the requested ix", async () => {
    setupHistory();
    const result = await fileAt({ tmp: dir, path: "src/foo.ts", ix: 15 });
    expect(result.content).toBe("v2 content");
    expect(result.version).toBe(2);
  });

  it("returns the latest version at-or-before the requested ix when ix is past the last snapshot", async () => {
    setupHistory();
    const result = await fileAt({ tmp: dir, path: "src/foo.ts", ix: 999 });
    expect(result.content).toBe("v3 content");
    expect(result.version).toBe(3);
  });

  it("throws when no version exists at-or-before the requested ix", async () => {
    setupHistory();
    await expect(fileAt({ tmp: dir, path: "src/foo.ts", ix: 0 })).rejects.toThrow(
      /no version of src\/foo\.ts/i
    );
  });

  it("throws when the file is not tracked at all", async () => {
    setupHistory();
    await expect(fileAt({ tmp: dir, path: "src/missing.ts", ix: 10 })).rejects.toThrow(
      /not tracked/i
    );
  });

  it("throws when snapshots.json does not exist", async () => {
    await expect(fileAt({ tmp: dir, path: "x", ix: 0 })).rejects.toThrow(/snapshots\.json/);
  });
});
