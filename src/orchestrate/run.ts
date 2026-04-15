import { tmpdir } from "node:os";
import path from "node:path";
// src/orchestrate/run.ts
import { Session } from "parse-claude-logs";
import { distill } from "../agent/distill.js";
import type { AgentRunner } from "../agent/types.js";
import { analyze } from "../analyze/index.js";
import { mergeArtifactFromPaths } from "../artifact/merge.js";
import { stage } from "../stage/index.js";
import { buildMetadata } from "../stage/metadata.js";
import { computeDistillerUsageFromLog } from "./compute-distiller-usage.js";
import { captureDistillerLog } from "./distiller-log-capture.js";
import { persistArtifact } from "./persist.js";
import { resolveSessionPath } from "./resolve.js";
import { cleanupTmpWorkspace, makeTmpWorkspace } from "./tmp.js";

/** Options for the top-level run. */
export interface RunOptions {
  /** Session argument: an absolute path or path relative to cwd. */
  session: string;
  /** Output root. Default ~/.alembic. */
  outputRoot?: string;
  /** Tmp workspace root. Default $TMPDIR/alembic. */
  tmpRoot?: string;
  /** Agent runner to use. Required. */
  runner: AgentRunner;
  /** Keep tmp dir on success. Default false. Always keeps on failure. */
  keepTmp?: boolean;
  /** Max distill retries. Default 2. */
  maxRetries?: number;
  /** Forwarded to stage(): inline budget in bytes (default 2048). */
  maxInlineBytes?: number;
  /** Print a condensation report to stderr after staging. Default false. */
  verbose?: boolean;
}

/** Result of a top-level run. */
export interface RunResult {
  success: boolean;
  /** Final artifact path (on success). */
  artifactPath?: string;
  /** Tmp dir used (set whether success or failure). */
  tmpDir?: string;
  /** Error message (failure only). */
  error?: string;
  /** Lint errors from the last distill attempt (if it failed that way). */
  lintErrors?: string[];
  /** Token usage reported by the distiller runner. */
  tokensUsed?: { in: number; out: number; cache_read?: number; cache_write?: number };
  /** Token totals from the source session's deterministic analysis. */
  sourceTokens?: { in: number; out: number; cache_read: number; cache_write: number };
  /** Where the distiller's own session log was captured to. */
  distillerLogDir?: string;
}

/**
 * Run the full alembic pipeline against a session:
 *   1. Resolve the session path
 *   2. Stage into a tmp dir
 *   3. Analyze deterministically
 *   4. Distill via the agent runner (with lint-gate retry)
 *   5. Merge + persist the artifact
 *   6. Clean up tmp (if success and !keepTmp)
 */
export async function run(opts: RunOptions): Promise<RunResult> {
  const sessionPath = await resolveSessionPath(opts.session);
  const session = new Session(sessionPath);

  // Prime session metadata so we know the session id for tmp naming
  await session.messages();

  const tmpRoot = opts.tmpRoot ?? path.join(tmpdir(), "alembic");
  const tmpDir = await makeTmpWorkspace({ root: tmpRoot, sessionId: session.sessionId });

  try {
    const layout = await stage(session, tmpDir, { maxInlineBytes: opts.maxInlineBytes });
    if (opts.verbose && layout.condenseStats) {
      const { formatCondenseStats } = await import("../stage/format-stats.js");
      process.stderr.write(
        `${formatCondenseStats(layout.condenseStats, {
          title: `Condensation report (maxInlineBytes=${opts.maxInlineBytes ?? 2048})`,
        })}\n`
      );
    }
    const metadata = await buildMetadata(session);
    const deterministic = await analyze(session);

    const distillResult = await distill({
      tmpDir,
      runner: opts.runner,
      maxRetries: opts.maxRetries,
    });

    // Capture distiller logs regardless of success/failure so we have
    // them for debugging.
    const capture = await captureDistillerLog({
      tmpDir,
      sessionId: session.sessionId,
      outputRoot: opts.outputRoot,
    });

    // Compute authoritative distiller token usage from the captured
    // log (the SDK adapter's numbers are unreliable — undercounts
    // by ~3x. See docs/followups.md).
    const authoritativeTokens = capture.destDir
      ? await computeDistillerUsageFromLog(capture.destDir)
      : null;
    const tokensUsed = authoritativeTokens ?? distillResult.tokensUsed;

    if (!distillResult.success) {
      return {
        success: false,
        tmpDir,
        error: distillResult.error,
        lintErrors: distillResult.lintErrors,
        tokensUsed,
        sourceTokens: deterministic.tokens.totals,
        distillerLogDir: capture.destDir || undefined,
      };
    }

    const artifact = await mergeArtifactFromPaths({
      metadata,
      deterministic,
      narrativePath: path.join(tmpDir, "out", "narrative.json"),
    });

    const artifactPath = await persistArtifact(artifact, { outputRoot: opts.outputRoot });

    await cleanupTmpWorkspace(tmpDir, { keep: opts.keepTmp ?? false });

    return {
      success: true,
      artifactPath,
      tmpDir,
      tokensUsed,
      sourceTokens: deterministic.tokens.totals,
      distillerLogDir: capture.destDir || undefined,
    };
  } catch (err) {
    // Retain tmp on any failure
    return {
      success: false,
      tmpDir,
      error: err instanceof Error ? (err.stack ?? err.message) : String(err),
    };
  }
}
