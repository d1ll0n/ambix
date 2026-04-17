// src/info/index.ts
import type { Session } from "parse-cc";
import { aggregateTokens } from "../analyze/tokens.js";
import type { TokensSummary } from "../analyze/types.js";
import { buildMetadata } from "../stage/metadata.js";
import type { MetadataJson } from "../types.js";

export interface SessionInfo {
  metadata: MetadataJson;
  tokens: TokensSummary;
}

/**
 * Minimal session summary: structural metadata + token rollup.
 * Deliberately does not run the full analyze pipeline — this is the
 * cheap "what is this session?" view.
 */
export async function sessionInfo(session: Session): Promise<SessionInfo> {
  const [metadata, tokens] = await Promise.all([buildMetadata(session), aggregateTokens(session)]);
  return { metadata, tokens };
}
