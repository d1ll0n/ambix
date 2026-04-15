import { Session } from "parse-claude-logs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inventorySpills } from "../../src/analyze/spills.js";
import {
  cleanupTempDir,
  joinLines,
  makeTempDir,
  toolResultUserLine,
  toolUseAssistantLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("inventorySpills", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("collects every <persisted-output> reference in tool_results", async () => {
    const persisted =
      "<persisted-output>\nOutput too large (51.3KB). Full output saved to: /abs/tool-results/toolu_X.json\n\nPreview (first 2KB):\nhi\n";
    const text = joinLines(
      toolUseAssistantLine({ name: "Bash", input: { command: "ls" }, toolUseId: "toolu_X" }),
      toolResultUserLine({ toolUseId: "toolu_X", content: persisted })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    const spills = inventorySpills(entries);

    expect(spills).toHaveLength(1);
    expect(spills[0].tool_use_id).toBe("toolu_X");
    expect(spills[0].file_path).toBe("/abs/tool-results/toolu_X.json");
    expect(spills[0].size_label).toBe("51.3KB");
    expect(spills[0].owning_ix).toBe(1);
  });

  it("returns empty array when there are no spills", async () => {
    const text = joinLines(
      toolUseAssistantLine({ name: "Read", input: { file_path: "a.ts" }, toolUseId: "t1" }),
      toolResultUserLine({ toolUseId: "t1", content: "small result" })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const entries = await session.messages();

    expect(inventorySpills(entries)).toEqual([]);
  });
});
