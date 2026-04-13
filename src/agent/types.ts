// src/agent/types.ts

/** Context handed to an AgentRunner when a distillation starts. */
export interface AgentRunContext {
  /** Absolute path to the staged tmp directory the agent works in. */
  tmpDir: string;
  /** System prompt describing role, goal, inputs, verification requirement. */
  systemPrompt: string;
  /** Initial user message that kicks off the agent's work. */
  initialMessage: string;
  /** Follow-up messages to replay on retry (lint errors, etc.). */
  followUpMessages?: ReadonlyArray<string>;
  /** Maximum turns before giving up. Default 100. */
  maxTurns?: number;
}

/** Result reported back by an AgentRunner after the agent finishes. */
export interface AgentRunResult {
  /** True if the agent declared done and wrote a narrative file. */
  success: boolean;
  /** Error message when success=false. */
  error?: string;
  /** Total token usage reported by the runner, if available. */
  tokensUsed?: {
    in: number;
    out: number;
    cache_read?: number;
    cache_write?: number;
  };
  /** Number of conversation turns consumed. */
  turnCount: number;
}

/** Minimal interface for whatever runs the distiller agent. */
export interface AgentRunner {
  run(ctx: AgentRunContext): Promise<AgentRunResult>;
}
