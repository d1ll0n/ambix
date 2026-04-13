import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { writeFullTurns } from "../../src/stage/turns.js";
import { makeTempDir, cleanupTempDir } from "../helpers/fixtures.js";

describe("writeFullTurns", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("writes a JSON file per truncated index, named with 5-digit zero padding", async () => {
    const entries = [
      { type: "user", uuid: "u1", message: { role: "user", content: "hello" } },
      { type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "world" }] } },
      { type: "user", uuid: "u2", message: { role: "user", content: "third" } },
    ];

    await writeFullTurns(dir, entries as never[], [0, 2]);

    expect(existsSync(path.join(dir, "00000.json"))).toBe(true);
    expect(existsSync(path.join(dir, "00001.json"))).toBe(false);
    expect(existsSync(path.join(dir, "00002.json"))).toBe(true);

    const turn0 = JSON.parse(readFileSync(path.join(dir, "00000.json"), "utf8"));
    expect(turn0).toEqual(entries[0]);
  });

  it("creates the destination directory if it does not exist", async () => {
    const sub = path.join(dir, "deeply", "nested", "turns");
    await writeFullTurns(sub, [{ type: "user", uuid: "u1" }] as never[], [0]);
    expect(existsSync(path.join(sub, "00000.json"))).toBe(true);
  });

  it("handles an empty truncated list as a no-op", async () => {
    await writeFullTurns(dir, [] as never[], []);
    // no error, no files created
    expect(existsSync(dir)).toBe(true);
  });
});
