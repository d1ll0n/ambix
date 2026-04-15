import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Session } from "parse-claude-logs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stage } from "../../src/stage/index.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  userLine,
  writeFixture,
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

  it("populates turns/ when truncation stubs are nested inside a tool_use input", async () => {
    const big = "y".repeat(5000);
    const text = joinLines(
      assistantLine({
        uuid: "a1",
        contentBlocks: [
          {
            type: "tool_use",
            id: "toolu_X",
            name: "Edit",
            input: { file_path: "src/big.ts", old_string: big, new_string: "ok" },
          },
        ],
      })
    );
    const session = new Session(writeFixture(dir, "src.jsonl", text));

    const tmpRoot = path.join(dir, "tmp");
    const layout = await stage(session, tmpRoot);

    // The stub is nested inside tool_use.input.old_string — if
    // containsTruncationStub doesn't recurse into object fields, this
    // entry won't be in truncatedIndices and the full-turn file won't
    // be written. Regression guard for the smoke-test finding where
    // turns/NNNNN.json was missing despite a stub ref pointing at it.
    expect(layout.truncatedIndices).toEqual([0]);
    expect(existsSync(path.join(layout.turnsDir, "00000.json"))).toBe(true);
  });

  it("populates turns/ when a text block's text field is truncated", async () => {
    const big = "w".repeat(5000);
    const text = joinLines(
      assistantLine({
        uuid: "a1",
        contentBlocks: [{ type: "text", text: big }],
      })
    );
    const session = new Session(writeFixture(dir, "src.jsonl", text));

    const tmpRoot = path.join(dir, "tmp");
    const layout = await stage(session, tmpRoot);

    expect(layout.truncatedIndices).toEqual([0]);
    expect(existsSync(path.join(layout.turnsDir, "00000.json"))).toBe(true);
  });

  it("creates out/ and bin/ directories with a lint-output wrapper script", async () => {
    const text = joinLines(
      userLine({ text: "hello", uuid: "u1" }),
      assistantLine({ text: "world", uuid: "a1", parentUuid: "u1" })
    );
    const session = new Session(writeFixture(dir, "src.jsonl", text));

    const tmpRoot = path.join(dir, "tmp");
    const layout = await stage(session, tmpRoot);

    expect(existsSync(layout.outDir)).toBe(true);
    expect(existsSync(layout.binDir)).toBe(true);
    const wrapperPath = path.join(layout.binDir, "lint-output");
    expect(existsSync(wrapperPath)).toBe(true);
    const { readFileSync, statSync } = await import("node:fs");
    const wrapper = readFileSync(wrapperPath, "utf8");
    expect(wrapper.startsWith("#!/bin/bash") || wrapper.startsWith("#!/usr/bin/env bash")).toBe(
      true
    );
    expect(wrapper).toContain("lint-cli");
    const mode = statSync(wrapperPath).mode;
    expect(mode & 0o100).not.toBe(0);

    const queryWrapperPath = path.join(layout.binDir, "query");
    expect(existsSync(queryWrapperPath)).toBe(true);
    const queryWrapper = readFileSync(queryWrapperPath, "utf8");
    expect(
      queryWrapper.startsWith("#!/bin/bash") || queryWrapper.startsWith("#!/usr/bin/env bash")
    ).toBe(true);
    expect(queryWrapper).toContain("query/cli");
    const queryMode = statSync(queryWrapperPath).mode;
    expect(queryMode & 0o100).not.toBe(0);

    const fileAtWrapperPath = path.join(layout.binDir, "file-at");
    expect(existsSync(fileAtWrapperPath)).toBe(true);
    const fileAtWrapper = readFileSync(fileAtWrapperPath, "utf8");
    expect(
      fileAtWrapper.startsWith("#!/bin/bash") || fileAtWrapper.startsWith("#!/usr/bin/env bash")
    ).toBe(true);
    expect(fileAtWrapper).toContain("cli.js file-at");
    const fileAtMode = statSync(fileAtWrapperPath).mode;
    expect(fileAtMode & 0o100).not.toBe(0);
  });
});
