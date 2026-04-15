// src/artifact/merge.ts
import { readFile } from "node:fs/promises";
import type { MetadataJson } from "../types.js";
import type { AnalyzeResult } from "../analyze/index.js";
import type { Artifact, Narrative } from "./types.js";

/** Inputs for building a final artifact from in-memory pieces. */
export interface MergeArtifactInput {
  metadata: MetadataJson;
  deterministic: AnalyzeResult;
  narrative: Narrative;
}

/** Inputs for building a final artifact when the narrative lives on disk. */
export interface MergeArtifactFromPathsInput {
  metadata: MetadataJson;
  deterministic: AnalyzeResult;
  narrativePath: string;
}

/** Core merge function: combines three pieces into one Artifact. */
export function mergeArtifact(input: MergeArtifactInput): Artifact {
  return {
    schema_version: "1",
    session_id: input.metadata.session_id,
    generated_at: new Date().toISOString(),
    metadata: input.metadata,
    deterministic: input.deterministic,
    narrative: input.narrative,
  };
}

/** Read narrative.json from disk, then merge into an Artifact. */
export async function mergeArtifactFromPaths(
  input: MergeArtifactFromPathsInput
): Promise<Artifact> {
  const narrative = JSON.parse(await readFile(input.narrativePath, "utf8")) as Narrative;
  return mergeArtifact({
    metadata: input.metadata,
    deterministic: input.deterministic,
    narrative,
  });
}
