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
