import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stageFileHistory } from "../../src/stage/file-history.js";
import type { SnapshotsIndex } from "../../src/types.js";
import { cleanupTempDir, joinLines, makeTempDir, writeFixture } from "../helpers/fixtures.js";

describe("stageFileHistory", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("writes snapshots.json and copies blobs into blobs/", async () => {
    // file-history source dir
    const fhSrc = path.join(dir, "fh-source");
    const sessionFhDir = path.join(fhSrc, "session-test");
    mkdirSync(sessionFhDir, { recursive: true });
    writeFileSync(path.join(sessionFhDir, "abc123@v1"), "version 1 content");
    writeFileSync(path.join(sessionFhDir, "abc123@v2"), "version 2 content");

    // session JSONL with file-history-snapshot entries
    const text = joinLines(
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "session-test",
        timestamp: "2026-04-13T10:00:00Z",
        message: { role: "user", content: "hi" },
      }),
      JSON.stringify({
        type: "file-history-snapshot",
        messageId: "msg_1",
        snapshot: {
          messageId: "msg_1",
          timestamp: "2026-04-13T10:00:01Z",
          trackedFileBackups: {
            "src/foo.ts": {
              backupFileName: "abc123@v1",
              version: 1,
              backupTime: "2026-04-13T10:00:01Z",
            },
          },
        },
      }),
      JSON.stringify({
        type: "file-history-snapshot",
        messageId: "msg_2",
        snapshot: {
          messageId: "msg_2",
          timestamp: "2026-04-13T10:00:02Z",
          trackedFileBackups: {
            "src/foo.ts": {
              backupFileName: "abc123@v2",
              version: 2,
              backupTime: "2026-04-13T10:00:02Z",
            },
          },
        },
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    await session.messages();

    const destDir = path.join(dir, "file-history");
    await stageFileHistory(session, destDir, fhSrc);

    expect(existsSync(path.join(destDir, "snapshots.json"))).toBe(true);
    expect(existsSync(path.join(destDir, "blobs", "abc123@v1"))).toBe(true);
    expect(existsSync(path.join(destDir, "blobs", "abc123@v2"))).toBe(true);

    const idx = JSON.parse(
      readFileSync(path.join(destDir, "snapshots.json"), "utf8")
    ) as SnapshotsIndex;
    expect(idx.files).toHaveLength(1);
    expect(idx.files[0].path).toBe("src/foo.ts");
    expect(idx.files[0].versions).toHaveLength(2);
    expect(idx.files[0].versions[0].version).toBe(1);
    expect(idx.files[0].versions[0].blob).toBe("blobs/abc123@v1");
    expect(idx.files[0].versions[0].ix).toBe(1); // first snapshot is at ix=1
    expect(idx.files[0].versions[1].version).toBe(2);
    expect(idx.files[0].versions[1].ix).toBe(2);
  });

  it("does nothing when the session has no file-history entries", async () => {
    const text = joinLines(
      JSON.stringify({
        type: "user",
        uuid: "u1",
        parentUuid: null,
        sessionId: "session-test",
        timestamp: "2026-04-13T10:00:00Z",
        message: { role: "user", content: "hi" },
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    await session.messages();

    const destDir = path.join(dir, "file-history");
    await stageFileHistory(session, destDir, dir);

    expect(existsSync(destDir)).toBe(false);
  });
});
