import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Session } from "parse-claude-logs";
import { stage } from "../../src/stage/index.js";
import {
  makeTempDir,
  cleanupTempDir,
  writeFixture,
  joinLines,
  userLine,
  assistantLine,
} from "../helpers/fixtures.js";

describe("stage", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("produces metadata.json, session.jsonl, and reports an empty layout for a minimal session", async () => {
    const text = joinLines(
      userLine({ text: "hello", uuid: "u1" }),
      assistantLine({ text: "world", uuid: "a1", parentUuid: "u1" })
    );
    const session = new Session(writeFixture(dir, "src.jsonl", text));

    const tmpRoot = path.join(dir, "tmp");
    const layout = await stage(session, tmpRoot);

    expect(layout.tmpDir).toBe(tmpRoot);
    expect(existsSync(layout.metadataPath)).toBe(true);
    expect(existsSync(layout.sessionPath)).toBe(true);

    const meta = JSON.parse(readFileSync(layout.metadataPath, "utf8"));
    expect(meta.session_id).toBe("session-test");
    expect(meta.turn_count).toBe(2);

    const lines = readFileSync(layout.sessionPath, "utf8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).ix).toBe(0);
    expect(JSON.parse(lines[1]).ix).toBe(1);

    expect(layout.truncatedIndices).toEqual([]);
    expect(layout.spillCount).toBe(0);
    expect(layout.subagentCount).toBe(0);
  });

  it("populates turns/ for truncated entries", async () => {
    const big = "z".repeat(5000);
    const text = joinLines(userLine({ text: big, uuid: "u1" }));
    const session = new Session(writeFixture(dir, "src.jsonl", text));

    const tmpRoot = path.join(dir, "tmp");
    const layout = await stage(session, tmpRoot);

    expect(layout.truncatedIndices).toEqual([0]);
    expect(existsSync(path.join(layout.turnsDir, "00000.json"))).toBe(true);
  });
});
