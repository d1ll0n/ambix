import type { AnalyzeResult } from "../analyze/index.js";
// src/artifact/types.ts
import type { MetadataJson } from "../types.js";

/** Top-level final artifact written to ~/.alembic/sessions/<id>/artifact.json. */
export interface Artifact {
  schema_version: "1";
  session_id: string;
  generated_at: string;
  metadata: MetadataJson;
  deterministic: AnalyzeResult;
  narrative: Narrative;
}

/** Agent-produced narrative slot of the artifact. Matches out/narrative.json. */
export interface Narrative {
  summary: string;
  main_tasks: MainTask[];
  episodes: Episode[];
  decisions: Decision[];
  corrections: Correction[];
  verification: Verification;
  friction_points: FrictionPoint[];
  wins: Win[];
  unresolved: Unresolved[];
}

export interface MainTask {
  title: string;
  status: "completed" | "partial" | "abandoned" | "verified";
  description: string;
  refs: number[];
}

export interface Episode {
  title: string;
  kind:
    | "research"
    | "planning"
    | "implementation"
    | "debugging"
    | "review"
    | "housekeeping"
    | "other";
  ix_range: [number, number];
  summary: string;
  refs: number[];
}

export interface Decision {
  description: string;
  rationale: string;
  refs: number[];
}

export interface Correction {
  description: string;
  kind: "self_correction" | "user_correction" | "subagent_error";
  refs: number[];
}

export interface Verification {
  was_verified: boolean;
  how: string;
  refs: number[];
}

export interface FrictionPoint {
  description: string;
  refs: number[];
  /** Optional free-form suggestion about the likely source of the friction. */
  attribution?: string;
}

export interface Win {
  description: string;
  refs: number[];
}

export interface Unresolved {
  description: string;
  refs: number[];
}
