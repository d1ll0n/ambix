import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lintNarrative } from "../../src/agent/lint.js";
import {
  type QueryFn,
  RealAgentRunner,
  type StreamedAgentMessage,
  aggregateResultTokens,
  resolvePermissionMode,
} from "../../src/agent/runner-real.js";
import type { Narrative } from "../../src/artifact/types.js";
import { cleanupTempDir, makeTempDir } from "../helpers/fixtures.js";

function validNarrative(turnCount: number): Narrative {
  return {
    summary: `Real distillation of ${turnCount}-turn session.`,
    main_tasks: [{ title: "T", status: "completed", description: "d", refs: [0] }],
    episodes: [
      { title: "E", kind: "other", ix_range: [0, turnCount - 1], summary: "s", refs: [0] },
    ],
    decisions: [],
    corrections: [],
    verification: { was_verified: true, how: "x", refs: [0] },
    friction_points: [],
    wins: [],
    unresolved: [],
  };
}

function setupTmp(dir: string, turnCount: number): void {
  mkdirSync(path.join(dir, "out"), { recursive: true });
  const lines: string[] = [];
  for (let i = 0; i < turnCount; i++) {
    lines.push(
      JSON.stringify({
        ix: i,
        ref: `uuid:${i}`,
        role: "user",
        type: "user",
        ts: null,
        content: `t${i}`,
      })
    );
  }
  writeFileSync(path.join(dir, "session.jsonl"), `${lines.join("\n")}\n`);
  writeFileSync(
    path.join(dir, "metadata.json"),
    JSON.stringify({ session_id: "sess", turn_count: turnCount, end_state: "completed" })
  );
}

describe("RealAgentRunner", () => {
  let dir: string;
  beforeEach(() => {
    dir = makeTempDir();
  });
  afterEach(() => {
    cleanupTempDir(dir);
  });

  it("passes cwd, systemPrompt, allowedTools, and the initial message to the query function", async () => {
    setupTmp(dir, 2);
    let capturedOpts: unknown = null;
    const queryFn: QueryFn = async function* (opts) {
      capturedOpts = opts;
      writeFileSync(
        path.join(opts.cwd, "out", "narrative.json"),
        JSON.stringify(validNarrative(2))
      );
      yield { type: "done", tokens: { in: 10, out: 5 } } as StreamedAgentMessage;
    };

    const runner = new RealAgentRunner({ queryFn, model: "claude-sonnet-4-6" });
    await runner.run({
      tmpDir: dir,
      systemPrompt: "you are a distiller",
      initialMessage: "please distill",
    });

    const opts = capturedOpts as {
      cwd: string;
      systemPrompt: string;
      messages: Array<{ role: string; content: string }>;
      allowedTools: string[];
      model: string;
      permissionMode: string;
    };
    expect(opts.cwd).toBe(dir);
    expect(opts.systemPrompt).toBe("you are a distiller");
    expect(opts.messages[0].role).toBe("user");
    expect(opts.messages[0].content).toBe("please distill");
    expect(opts.model).toBe("claude-sonnet-4-6");
    expect(opts.allowedTools).toEqual(
      expect.arrayContaining(["Read", "Glob", "Grep", "Bash", "Write"])
    );
    expect(typeof opts.permissionMode).toBe("string");
  });

  it("returns success=true after the agent writes a narrative and streams done", async () => {
    setupTmp(dir, 2);
    const queryFn: QueryFn = async function* (opts) {
      writeFileSync(
        path.join(opts.cwd, "out", "narrative.json"),
        JSON.stringify(validNarrative(2))
      );
      yield { type: "tool_use", content: "Write" } as StreamedAgentMessage;
      yield { type: "tool_result", content: "ok" } as StreamedAgentMessage;
      yield { type: "text", content: "done" } as StreamedAgentMessage;
      yield { type: "done", tokens: { in: 1000, out: 500 } } as StreamedAgentMessage;
    };
    const runner = new RealAgentRunner({ queryFn });
    const result = await runner.run({
      tmpDir: dir,
      systemPrompt: "x",
      initialMessage: "go",
    });
    expect(result.success).toBe(true);
    expect(result.tokensUsed).toEqual({ in: 1000, out: 500 });
    expect(result.turnCount).toBeGreaterThan(0);
    const errors = await lintNarrative(dir);
    expect(errors).toEqual([]);
  });

  it("appends followUpMessages after the initial message", async () => {
    setupTmp(dir, 2);
    let capturedMessages: Array<{ role: string; content: string }> = [];
    const queryFn: QueryFn = async function* (opts) {
      capturedMessages = opts.messages as typeof capturedMessages;
      writeFileSync(
        path.join(opts.cwd, "out", "narrative.json"),
        JSON.stringify(validNarrative(2))
      );
      yield { type: "done", tokens: { in: 10, out: 5 } } as StreamedAgentMessage;
    };

    const runner = new RealAgentRunner({ queryFn });
    await runner.run({
      tmpDir: dir,
      systemPrompt: "x",
      initialMessage: "go",
      followUpMessages: ["fix the refs", "also fix the enum"],
    });

    expect(capturedMessages).toHaveLength(3);
    expect(capturedMessages[0].content).toBe("go");
    expect(capturedMessages[1].content).toBe("fix the refs");
    expect(capturedMessages[2].content).toBe("also fix the enum");
  });

  it("returns success=false and surfaces the error when the stream emits type=error", async () => {
    setupTmp(dir, 2);
    const queryFn: QueryFn = async function* () {
      yield { type: "error", error: "rate limited" } as StreamedAgentMessage;
    };

    const runner = new RealAgentRunner({ queryFn });
    const result = await runner.run({
      tmpDir: dir,
      systemPrompt: "x",
      initialMessage: "go",
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("rate limited");
  });

  it("counts turnCount from text + tool_use messages in the stream", async () => {
    setupTmp(dir, 2);
    const queryFn: QueryFn = async function* (opts) {
      writeFileSync(
        path.join(opts.cwd, "out", "narrative.json"),
        JSON.stringify(validNarrative(2))
      );
      yield { type: "text", content: "thinking" } as StreamedAgentMessage;
      yield { type: "tool_use", content: "Read" } as StreamedAgentMessage;
      yield { type: "tool_result", content: "..." } as StreamedAgentMessage;
      yield { type: "text", content: "done" } as StreamedAgentMessage;
      yield { type: "tool_use", content: "Write" } as StreamedAgentMessage;
      yield { type: "tool_result", content: "ok" } as StreamedAgentMessage;
      yield { type: "done", tokens: { in: 100, out: 50 } } as StreamedAgentMessage;
    };
    const runner = new RealAgentRunner({ queryFn });
    const result = await runner.run({
      tmpDir: dir,
      systemPrompt: "x",
      initialMessage: "go",
    });
    expect(result.turnCount).toBeGreaterThanOrEqual(2);
  });
});

describe("aggregateResultTokens", () => {
  // Guards against SDK drift: if a future SDK version renames modelUsage or
  // changes its aggregation semantics, aggregateResultTokens must fall back
  // to the top-level usage field rather than silently returning zeros.
  // The log-derived authoritative path in orchestrate/run.ts still supersedes
  // this value whenever capture succeeds, but this branch is the backup when
  // capture fails.

  it("prefers modelUsage and sums across models when populated", () => {
    const result = {
      usage: {
        // Last-turn only — would undercount. Adapter must NOT use this.
        input_tokens: 50,
        output_tokens: 25,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
      },
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 100,
          outputTokens: 200,
          cacheReadInputTokens: 3000,
          cacheCreationInputTokens: 400,
        },
        "claude-opus-4-7": {
          inputTokens: 50,
          outputTokens: 100,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 300,
        },
      },
    };
    expect(aggregateResultTokens(result)).toEqual({
      in: 150,
      out: 300,
      cache_read: 5000,
      cache_write: 700,
    });
  });

  it("falls back to top-level usage when modelUsage is missing", () => {
    const result = {
      usage: {
        input_tokens: 50,
        output_tokens: 25,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
      },
    };
    expect(aggregateResultTokens(result)).toEqual({
      in: 50,
      out: 25,
      cache_read: 1000,
      cache_write: 500,
    });
  });

  it("falls back to top-level usage when modelUsage is empty", () => {
    const result = {
      usage: {
        input_tokens: 50,
        output_tokens: 25,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 500,
      },
      modelUsage: {},
    };
    expect(aggregateResultTokens(result)).toEqual({
      in: 50,
      out: 25,
      cache_read: 1000,
      cache_write: 500,
    });
  });

  it("defaults missing modelUsage fields to zero", () => {
    const result = {
      modelUsage: {
        "claude-sonnet-4-6": { inputTokens: 100, outputTokens: 200 },
      },
    };
    expect(aggregateResultTokens(result)).toEqual({
      in: 100,
      out: 200,
      cache_read: 0,
      cache_write: 0,
    });
  });

  it("returns zero totals when neither modelUsage nor usage is populated", () => {
    expect(aggregateResultTokens({})).toEqual({
      in: 0,
      out: 0,
      cache_read: undefined,
      cache_write: undefined,
    });
  });
});

describe("resolvePermissionMode", () => {
  it("returns explicit mode when provided, regardless of root", () => {
    expect(resolvePermissionMode("plan", false)).toBe("plan");
    expect(resolvePermissionMode("plan", true)).toBe("plan");
  });

  it("defaults to acceptEdits under root", () => {
    // Suppress the warning during the test to keep stderr clean
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(resolvePermissionMode(undefined, true)).toBe("acceptEdits");
    } finally {
      console.warn = origWarn;
    }
  });

  it("defaults to bypassPermissions when not root", () => {
    expect(resolvePermissionMode(undefined, false)).toBe("bypassPermissions");
  });
});
