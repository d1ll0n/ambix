// src/index.ts
export const VERSION = "0.0.1";

export { stage } from "./stage/index.js";
export type { StageOptions } from "./stage/index.js";
export { fileAt } from "./file-at.js";
export type { FileAtArgs, FileAtResult } from "./file-at.js";
export type {
  CondensedEntry,
  RehydrationStub,
  MetadataJson,
  SnapshotsIndex,
  StageLayout,
} from "./types.js";

export { analyze } from "./analyze/index.js";
export type {
  AnalyzeResult,
  TokensSummary,
  ModelTokens,
  ToolsSummary,
  FilesSummary,
  FileRecord,
  ChurnRecord,
  BashCluster,
  FailureRecord,
  SubagentRecord,
  SpillRecord,
  PermissionEvent,
} from "./analyze/index.js";

export { run } from "./orchestrate/run.js";
export type { RunOptions, RunResult } from "./orchestrate/run.js";
export type { AgentRunner, AgentRunContext, AgentRunResult } from "./agent/types.js";
export { MockAgentRunner } from "./agent/runner-mock.js";
export { distill } from "./agent/distill.js";
export type { DistillOptions, DistillResult } from "./agent/distill.js";
export { mergeArtifact } from "./artifact/merge.js";
export type {
  Artifact,
  Narrative,
  MainTask,
  Episode,
  Decision,
  Correction,
  Verification,
  FrictionPoint,
  Win,
  Unresolved,
} from "./artifact/types.js";
export { persistArtifact } from "./orchestrate/persist.js";
export type { PersistOptions } from "./orchestrate/persist.js";
export { resolveSessionPath } from "./orchestrate/resolve.js";
export { buildSystemPrompt } from "./agent/system-prompt.js";
export { lintNarrative } from "./agent/lint.js";
export { RealAgentRunner } from "./agent/runner-real.js";
export type { RealAgentRunnerOptions, QueryFn, QueryFnOptions, StreamedAgentMessage } from "./agent/runner-real.js";
