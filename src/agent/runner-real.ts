// src/agent/runner-real.ts
import type { AgentRunContext, AgentRunResult, AgentRunner } from "./types.js";

/** Internal abstraction of SDK-streamed messages. */
export interface StreamedAgentMessage {
  type: "text" | "tool_use" | "tool_result" | "done" | "error";
  content?: string;
  tokens?: {
    in: number;
    out: number;
    cache_read?: number;
    cache_write?: number;
  };
  error?: string;
}

/** Options passed to the injectable query function. */
export interface QueryFnOptions {
  cwd: string;
  systemPrompt: string;
  messages: Array<{ role: "user"; content: string }>;
  model: string;
  maxTurns: number;
  allowedTools: string[];
}

/** The injectable query function signature. */
export type QueryFn = (opts: QueryFnOptions) => AsyncIterable<StreamedAgentMessage>;

/** Options for constructing a RealAgentRunner. */
export interface RealAgentRunnerOptions {
  /** The query function to use. Defaults to the real SDK-backed implementation. */
  queryFn?: QueryFn;
  /** Model to request. Default "claude-sonnet-4-6". */
  model?: string;
  /** Max turns inside the agent loop. Default 100. */
  maxTurns?: number;
  /** Tools to allow. Default ["Read", "Glob", "Grep", "Bash", "Write"]. */
  allowedTools?: string[];
}

const DEFAULT_TOOLS = ["Read", "Glob", "Grep", "Bash", "Write"];
const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_MAX_TURNS = 100;

/**
 * Production AgentRunner that spawns the distiller via the Claude
 * Agent SDK. The SDK's query function is dependency-injected so unit
 * tests can exercise the adapter layer without network calls.
 */
export class RealAgentRunner implements AgentRunner {
  private readonly queryFn: QueryFn;
  private readonly model: string;
  private readonly maxTurns: number;
  private readonly allowedTools: string[];

  constructor(opts: RealAgentRunnerOptions = {}) {
    this.queryFn = opts.queryFn ?? defaultQueryFn;
    this.model = opts.model ?? DEFAULT_MODEL;
    this.maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.allowedTools = opts.allowedTools ?? DEFAULT_TOOLS;
  }

  async run(ctx: AgentRunContext): Promise<AgentRunResult> {
    const messages: Array<{ role: "user"; content: string }> = [
      { role: "user", content: ctx.initialMessage },
    ];
    for (const follow of ctx.followUpMessages ?? []) {
      messages.push({ role: "user", content: follow });
    }

    const stream = this.queryFn({
      cwd: ctx.tmpDir,
      systemPrompt: ctx.systemPrompt,
      messages,
      model: this.model,
      maxTurns: ctx.maxTurns ?? this.maxTurns,
      allowedTools: this.allowedTools,
    });

    let turnCount = 0;
    let tokensUsed: AgentRunResult["tokensUsed"];
    let error: string | undefined;

    try {
      for await (const msg of stream) {
        switch (msg.type) {
          case "text":
          case "tool_use":
            turnCount++;
            break;
          case "tool_result":
            break;
          case "done":
            if (msg.tokens) tokensUsed = msg.tokens;
            break;
          case "error":
            error = msg.error ?? "unknown error";
            break;
        }
        if (error) break;
      }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        turnCount,
        tokensUsed,
      };
    }

    if (error) {
      return { success: false, error, turnCount, tokensUsed };
    }

    return { success: true, turnCount, tokensUsed };
  }
}

/**
 * Default production queryFn — wraps the real Claude Agent SDK.
 *
 * Translates the SDK's SDKMessage types into our StreamedAgentMessage
 * abstraction. For v1, multiple user messages are concatenated into
 * one prompt string separated by a divider — simpler than wiring up
 * an AsyncIterable<SDKUserMessage>.
 */
const defaultQueryFn: QueryFn = async function* (opts) {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");

  // Concatenate multi-message prompts into a single string
  const prompt = opts.messages
    .map((m) => m.content)
    .join("\n\n---\n\n");

  const stream = sdk.query({
    prompt,
    options: {
      cwd: opts.cwd,
      systemPrompt: opts.systemPrompt,
      model: opts.model,
      maxTurns: opts.maxTurns,
      allowedTools: opts.allowedTools,
      permissionMode: "bypassPermissions",
    },
  });

  for await (const msg of stream) {
    if (msg.type === "assistant") {
      // msg.message is a BetaMessage; walk its content blocks
      const content = (msg as { message?: { content?: Array<{ type: string; text?: string; name?: string }> } }).message?.content ?? [];
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") {
          yield { type: "text", content: block.text };
        } else if (block.type === "tool_use" && typeof block.name === "string") {
          yield { type: "tool_use", content: block.name };
        }
      }
    } else if (msg.type === "user") {
      // tool_result wrapped in a user message — we just acknowledge it
      yield { type: "tool_result" };
    } else if (msg.type === "result") {
      const r = msg as {
        subtype: string;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        errors?: string[];
      };
      if (r.subtype === "success") {
        yield {
          type: "done",
          tokens: {
            in: r.usage?.input_tokens ?? 0,
            out: r.usage?.output_tokens ?? 0,
            cache_read: r.usage?.cache_read_input_tokens,
            cache_write: r.usage?.cache_creation_input_tokens,
          },
        };
      } else {
        yield {
          type: "error",
          error: (r.errors ?? []).join("; ") || r.subtype,
        };
      }
    }
    // ignore system, stream_event, etc.
  }
};
