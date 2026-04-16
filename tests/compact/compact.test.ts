import { Session } from "parse-claude-logs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compactSession } from "../../src/compact/index.js";
import {
  assistantLine,
  cleanupTempDir,
  joinLines,
  makeTempDir,
  toolResultUserLine,
  toolUseAssistantLine,
  userLine,
  writeFixture,
} from "../helpers/fixtures.js";

describe("compactSession — end to end", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("renders rounds with idx attributes and a session header (xml)", async () => {
    const text = joinLines(
      userLine({ text: "please read the config", uuid: "u1" }),
      toolUseAssistantLine({
        uuid: "a1",
        parentUuid: "u1",
        name: "Read",
        input: { file_path: "/users/proj/p/src/config.ts" },
        toolUseId: "toolu_read",
      }),
      toolResultUserLine({
        uuid: "u2",
        parentUuid: "a1",
        toolUseId: "toolu_read",
        content: "     1\texport const foo = 1;\n     2\texport const bar = 2;",
      }),
      assistantLine({
        uuid: "a2",
        parentUuid: "u2",
        contentBlocks: [{ type: "text", text: "Config loaded. Both constants exported." }],
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const { content, stats } = await compactSession(session, { format: "xml" });

    expect(stats.rounds).toBe(1);
    expect(stats.toolUses).toBe(1);
    expect(content).toContain("<session ");
    expect(content).toContain('<round n="1">');
    expect(content).toMatch(/<user idx="\d+">/);
    expect(content).toContain("please read the config");
    expect(content).toMatch(/<tools idx="\d+">/);
    expect(content).toContain("Read p/src/config.ts");
    expect(content).toMatch(/<assistant idx="\d+">/);
    expect(content).toContain("Config loaded");
    expect(content).toContain("</session>");
  });

  it("renders an idx range when consecutive tool_uses span multiple entries", async () => {
    const text = joinLines(
      userLine({ text: "do stuff", uuid: "u1" }),
      toolUseAssistantLine({
        uuid: "a1",
        parentUuid: "u1",
        name: "Read",
        input: { file_path: "/users/proj/p/a.ts" },
        toolUseId: "t1",
      }),
      toolResultUserLine({ uuid: "u2", parentUuid: "a1", toolUseId: "t1", content: "abc" }),
      toolUseAssistantLine({
        uuid: "a2",
        parentUuid: "u2",
        name: "Read",
        input: { file_path: "/users/proj/p/b.ts" },
        toolUseId: "t2",
      }),
      toolResultUserLine({ uuid: "u3", parentUuid: "a2", toolUseId: "t2", content: "def" }),
      assistantLine({
        uuid: "a3",
        parentUuid: "u3",
        contentBlocks: [{ type: "text", text: "Done." }],
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const { content } = await compactSession(session, { format: "xml" });

    // Two consecutive Reads live at different entry ix'es; the <tools> tag
    // should carry a range idx="A-B" covering both. Per-line [N] prefixes
    // should reference each individual entry.
    expect(content).toMatch(/<tools idx="\d+-\d+">/);
    const toolBlock = content.match(/<tools[^>]*>([\s\S]*?)<\/tools>/)![1];
    expect(toolBlock).toMatch(/- \[\d+\] Read p\/a\.ts/);
    expect(toolBlock).toMatch(/- \[\d+\] Read p\/b\.ts/);
  });

  it('emits <git branch="..."/> marker only when the branch changes', async () => {
    const text = joinLines(
      userLine({ text: "first prompt", uuid: "u1", gitBranch: "main" }),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        contentBlocks: [{ type: "text", text: "ok" }],
      }),
      userLine({ text: "second prompt", uuid: "u2", gitBranch: "main" }),
      assistantLine({
        uuid: "a2",
        parentUuid: "u2",
        contentBlocks: [{ type: "text", text: "ok" }],
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const { content } = await compactSession(session, { format: "xml" });

    // Branch marker should appear exactly once (round 1), not twice.
    const markers = content.match(/<git branch="main"\/>/g) ?? [];
    expect(markers).toHaveLength(1);
  });

  it("filters out wrapper-only rounds (system-reminder / local-command-caveat)", async () => {
    const text = joinLines(
      userLine({
        text: "<local-command-caveat>Caveat: commands run locally</local-command-caveat>",
        uuid: "u1",
      }),
      userLine({ text: "real question", uuid: "u2" }),
      assistantLine({
        uuid: "a1",
        parentUuid: "u2",
        contentBlocks: [{ type: "text", text: "real answer" }],
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const { stats, content } = await compactSession(session, { format: "xml" });

    expect(stats.rawRounds).toBe(2);
    expect(stats.rounds).toBe(1);
    expect(content).toContain("real question");
    expect(content).not.toContain("local-command-caveat");
  });

  it("renders markdown format when requested", async () => {
    const text = joinLines(
      userLine({ text: "ping", uuid: "u1" }),
      assistantLine({
        uuid: "a1",
        parentUuid: "u1",
        contentBlocks: [{ type: "text", text: "pong" }],
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const { content } = await compactSession(session, { format: "markdown" });

    expect(content).toContain("# Session compaction");
    expect(content).toContain("## Round 1");
    expect(content).toMatch(/\*\*User\*\* `\[ix \d+\]`/);
    expect(content).toContain("> ping");
    expect(content).toMatch(/\*\*Assistant\*\* `\[ix \d+\]`/);
    expect(content).toContain("pong");
  });

  it("indexes a Bash git-commit success line and annotates the tool line", async () => {
    const text = joinLines(
      userLine({ text: "commit it", uuid: "u1" }),
      toolUseAssistantLine({
        uuid: "a1",
        parentUuid: "u1",
        name: "Bash",
        input: { command: "git commit -m 'fix'" },
        toolUseId: "t_bash",
      }),
      toolResultUserLine({
        uuid: "u2",
        parentUuid: "a1",
        toolUseId: "t_bash",
        content: "[main 57bc123] fix: bug\n 1 file changed, 1 insertion(+)",
      })
    );
    const session = new Session(writeFixture(dir, "session.jsonl", text));
    const { content } = await compactSession(session, { format: "xml" });

    expect(content).toMatch(/→ commit 57bc123/);
    expect(content).toContain("fix: bug");
  });
});
