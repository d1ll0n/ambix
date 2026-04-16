import { Session } from "parse-cc";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectPermissionEvents } from "../../src/analyze/permissions.js";
import {
  cleanupTempDir,
  joinLines,
  makeTempDir,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("collectPermissionEvents", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("records permission-mode entries and hook attachment entries", async () => {
    const text = joinLines(
      userLine({ text: "hi" }),
      JSON.stringify({
        type: "permission-mode",
        sessionId: "session-test",
        permissionMode: "bypassPermissions",
      }),
      JSON.stringify({
        type: "attachment",
        uuid: "att-1",
        parentUuid: null,
        sessionId: "session-test",
        timestamp: "2026-04-13T10:00:01Z",
        attachment: {
          type: "hook_additional_context",
          context: "test context",
        },
      }),
      JSON.stringify({
        type: "attachment",
        uuid: "att-2",
        parentUuid: null,
        sessionId: "session-test",
        timestamp: "2026-04-13T10:00:02Z",
        attachment: {
          type: "command_permissions",
          allowedCommands: ["ls", "cat"],
        },
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const events = collectPermissionEvents(entries);

    expect(events).toHaveLength(3);
    expect(events[0].kind).toBe("permission_mode");
    expect(events[0].ix).toBe(1);
    expect(events[1].kind).toBe("hook_additional_context");
    expect(events[2].kind).toBe("command_permissions");
  });

  it("returns empty array when there are no permission or hook events", async () => {
    const text = joinLines(userLine({ text: "nothing interesting" }));
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();
    expect(collectPermissionEvents(entries)).toEqual([]);
  });
});
