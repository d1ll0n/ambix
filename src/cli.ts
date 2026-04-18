#!/usr/bin/env node
// src/cli.ts
import { writeFile } from "node:fs/promises";
import { Session } from "parse-cc";
import { MockAgentRunner } from "./agent/runner-mock.js";
import { RealAgentRunner } from "./agent/runner-real.js";
import { analyze } from "./analyze/index.js";
import { buildBrief } from "./brief/index.js";
import { compactSession } from "./compact-session/index.js";
import { fileAt } from "./file-at.js";
import { formatSessionInfo } from "./info/format.js";
import { sessionInfo } from "./info/index.js";
import { resolveSessionPath } from "./orchestrate/resolve.js";
import { run } from "./orchestrate/run.js";
import { runQuery } from "./query/index.js";
import { formatCondenseStats } from "./stage/format-stats.js";
import { stage } from "./stage/index.js";

async function main(argv: string[]): Promise<number> {
  const [, , subcommand, ...rest] = argv;
  if (!subcommand) {
    printUsage();
    return 1;
  }

  switch (subcommand) {
    case "stage":
      return runStage(rest);
    case "file-at":
      return runFileAt(rest);
    case "analyze":
      return runAnalyze(rest);
    case "info":
      return runInfo(rest);
    case "distill":
      return runDistill(rest);
    case "brief":
      return runBrief(rest);
    case "compact":
      return runCompact(rest);
    case "query":
      return runQueryCmd(rest);
    case "--help":
    case "-h":
    case "help":
      printUsage();
      return 0;
    default:
      console.error(`ambix: unknown subcommand: ${subcommand}`);
      printUsage();
      return 1;
  }
}

async function runStage(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.error(
      "usage: ambix stage <session-path-or-id> [--tmp <tmp-dir>] [--max-inline-bytes <N>] [-v|--verbose]"
    );
    console.error("");
    console.error("Stage a session into a tmp workspace. Prints the StageLayout JSON on success.");
    console.error("");
    console.error("  <session-path-or-id>  path to a .jsonl file, or a session UUID (or prefix)");
    console.error("");
    console.error("flags:");
    console.error("  --tmp <dir>               tmp workspace root (default: $TMPDIR/ambix-<pid>)");
    console.error("  --max-inline-bytes <N>    inline budget in bytes for tool_results / text");
    console.error("                            and per-field tool_use inputs (default 2048)");
    console.error("  -v, --verbose             print a condensation report (per-kind counts,");
    console.error("                            original vs inlined bytes, truncation rate) to");
    console.error("                            stderr in addition to the StageLayout JSON");
    return 0;
  }
  const sessionArg = args[0];
  const tmpArg = parseFlag(args, "--tmp");
  const maxInlineBytesArg = parseFlag(args, "--max-inline-bytes");
  const verbose = args.includes("--verbose") || args.includes("-v");
  if (!sessionArg) {
    console.error("ambix stage: missing <session-path-or-id>");
    console.error(
      "usage: ambix stage <session-path-or-id> [--tmp <tmp-dir>] [--max-inline-bytes <N>] [-v|--verbose]"
    );
    return 1;
  }
  let maxInlineBytes: number | undefined;
  if (maxInlineBytesArg !== undefined) {
    maxInlineBytes = Number.parseInt(maxInlineBytesArg, 10);
    if (Number.isNaN(maxInlineBytes) || maxInlineBytes < 0) {
      console.error(`ambix stage: invalid --max-inline-bytes: ${maxInlineBytesArg}`);
      return 1;
    }
  }
  let sessionPath: string;
  try {
    sessionPath = await resolveSessionPath(sessionArg);
  } catch (err) {
    console.error(`ambix stage: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const session = new Session(sessionPath);
  const tmpDir = tmpArg ?? `${process.env.TMPDIR ?? "/tmp"}/ambix-${process.pid}`;
  const layout = await stage(session, tmpDir, { maxInlineBytes });
  if (verbose && layout.condenseStats) {
    process.stderr.write(
      `${formatCondenseStats(layout.condenseStats, {
        title: `Condensation report (maxInlineBytes=${maxInlineBytes ?? 2048})`,
      })}\n`
    );
  }
  console.log(JSON.stringify(layout, null, 2));
  return 0;
}

async function runFileAt(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.error("usage: ambix file-at <path> <ix> [--tmp <tmp-dir>]");
    console.error("");
    console.error("Print a tracked file's content as it existed at turn index <ix>.");
    console.error("");
    console.error("flags:");
    console.error("  --tmp <dir>   staged tmp dir (default: cwd)");
    return 0;
  }
  const filePath = args[0];
  const ixStr = args[1];
  const tmpArg = parseFlag(args, "--tmp");
  if (!filePath || !ixStr) {
    console.error("ambix file-at: missing arguments");
    console.error("usage: ambix file-at <path> <ix> [--tmp <tmp-dir>]");
    return 1;
  }
  const ix = Number.parseInt(ixStr, 10);
  if (Number.isNaN(ix)) {
    console.error(`ambix file-at: invalid ix: ${ixStr}`);
    return 1;
  }
  const tmp = tmpArg ?? process.cwd();
  const result = await fileAt({ tmp, path: filePath, ix });
  process.stdout.write(result.content);
  return 0;
}

async function runAnalyze(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.error("usage: ambix analyze <session-path-or-id>");
    console.error("");
    console.error("Deterministic analysis over a session. Prints AnalyzeResult JSON to stdout.");
    console.error("");
    console.error("  <session-path-or-id>  path to a .jsonl file, or a session UUID (or prefix)");
    return 0;
  }
  const sessionArg = args[0];
  if (!sessionArg) {
    console.error("ambix analyze: missing <session-path-or-id>");
    console.error("usage: ambix analyze <session-path-or-id>");
    return 1;
  }
  let sessionPath: string;
  try {
    sessionPath = await resolveSessionPath(sessionArg);
  } catch (err) {
    console.error(`ambix analyze: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const session = new Session(sessionPath);
  const result = await analyze(session);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function runInfo(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.error("usage: ambix info <session-path-or-id> [--json]");
    console.error("");
    console.error("Print a minimal session summary: structural metadata plus a token rollup");
    console.error("(totals + per-model). Cheaper than `analyze` — no tools/files/churn scan.");
    console.error("");
    console.error("  <session-path-or-id>  path to a .jsonl file, or a session UUID (or prefix)");
    console.error("");
    console.error("flags:");
    console.error("  --json   emit SessionInfo JSON instead of the human-readable text block");
    return 0;
  }
  const sessionArg = args[0];
  const asJson = args.includes("--json");
  if (!sessionArg) {
    console.error("ambix info: missing <session-path-or-id>");
    console.error("usage: ambix info <session-path-or-id> [--json]");
    return 1;
  }
  let sessionPath: string;
  try {
    sessionPath = await resolveSessionPath(sessionArg);
  } catch (err) {
    console.error(`ambix info: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const session = new Session(sessionPath);
  const info = await sessionInfo(session);
  if (asJson) {
    process.stdout.write(`${JSON.stringify(info, null, 2)}\n`);
  } else {
    process.stdout.write(formatSessionInfo(info));
  }
  return 0;
}

async function runDistill(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.error("usage: ambix distill <session-path-or-id> [flags]");
    console.error("");
    console.error("Run the full pipeline: stage → analyze → distill → merge → persist.");
    console.error("");
    console.error("  <session-path-or-id>  path to a .jsonl file, or a session UUID (or prefix)");
    console.error("");
    console.error("flags:");
    console.error("  --output <root>           artifact output root (default: ~/.ambix)");
    console.error("  --tmp-root <dir>          tmp workspace root (default: $TMPDIR/ambix)");
    console.error(
      "  --keep-tmp                retain tmp dir on success (always retained on failure)"
    );
    console.error("  --mock                    use MockAgentRunner (skips API calls)");
    console.error("  --model <id>              model ID passed to RealAgentRunner");
    console.error("  --max-inline-bytes <N>    inline budget in bytes for tool_results / text");
    console.error("                            and per-field tool_use inputs (default 2048)");
    console.error(
      "  -v, --verbose             print a condensation report to stderr before distill"
    );
    return 0;
  }
  const sessionArg = args[0];
  if (!sessionArg) {
    console.error("ambix distill: missing <session-path-or-id>");
    console.error(
      "usage: ambix distill <session-path-or-id> [--output <root>] [--tmp-root <dir>] [--keep-tmp] [--mock] [--model <id>] [--max-inline-bytes <N>] [-v|--verbose]"
    );
    return 1;
  }
  const outputRoot = parseFlag(args, "--output");
  const tmpRoot = parseFlag(args, "--tmp-root");
  const keepTmp = args.includes("--keep-tmp");
  const useMock = args.includes("--mock");
  const model = parseFlag(args, "--model");
  const maxInlineBytesArg = parseFlag(args, "--max-inline-bytes");
  const verbose = args.includes("--verbose") || args.includes("-v");

  let maxInlineBytes: number | undefined;
  if (maxInlineBytesArg !== undefined) {
    maxInlineBytes = Number.parseInt(maxInlineBytesArg, 10);
    if (Number.isNaN(maxInlineBytes) || maxInlineBytes < 0) {
      console.error(`ambix distill: invalid --max-inline-bytes: ${maxInlineBytesArg}`);
      return 1;
    }
  }

  const runner = useMock ? new MockAgentRunner() : new RealAgentRunner({ model });

  const result = await run({
    session: sessionArg,
    outputRoot,
    tmpRoot,
    runner,
    keepTmp,
    maxInlineBytes,
    verbose,
  });

  if (!result.success) {
    console.error("ambix distill: failed");
    if (result.error) console.error(`  error: ${result.error}`);
    if (result.lintErrors) {
      console.error("  lint errors:");
      for (const e of result.lintErrors) console.error(`    - ${e}`);
    }
    if (result.tmpDir) console.error(`  tmp retained at: ${result.tmpDir}`);
    return 1;
  }

  console.log(`artifact written to: ${result.artifactPath}`);
  if (result.sourceTokens && result.tokensUsed) {
    const src = result.sourceTokens;
    const d = result.tokensUsed;
    const srcTotal = src.in + src.out;
    const dTotal = d.in + d.out;
    const ratio = srcTotal > 0 ? (dTotal / srcTotal).toFixed(3) : "n/a";
    console.log(
      `source session tokens: in=${src.in} out=${src.out} cache_read=${src.cache_read} cache_write=${src.cache_write}`
    );
    console.log(
      `distiller tokens:      in=${d.in} out=${d.out}${d.cache_read != null ? ` cache_read=${d.cache_read}` : ""}${d.cache_write != null ? ` cache_write=${d.cache_write}` : ""}`
    );
    console.log(`distiller total / source total = ${ratio}`);
  }
  if (result.distillerLogDir) {
    console.log(`distiller session log captured at: ${result.distillerLogDir}`);
  }
  return 0;
}

async function runBrief(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.error(
      "usage: ambix brief <session-path-or-id> [--format xml|markdown] [--output <file>]"
    );
    console.error("");
    console.error("Produce a chronological, per-round summary of a session for context recovery.");
    console.error("Each round, tool_use, and assistant text block is tagged with a rehydration");
    console.error("index (the same ix `ambix query <session> <ix>` resolves to), so an agent");
    console.error("loading the brief output can pull full details for any entry on demand.");
    console.error("");
    console.error("  <session-path-or-id>  path to a .jsonl file, or a session UUID (or prefix)");
    console.error("");
    console.error("flags:");
    console.error("  --format xml|markdown   output format (default: xml)");
    console.error("  --output <file>         write to file instead of stdout");
    return 0;
  }
  const sessionArg = args[0];
  if (!sessionArg) {
    console.error("ambix brief: missing <session-path-or-id>");
    console.error(
      "usage: ambix brief <session-path-or-id> [--format xml|markdown] [--output <file>]"
    );
    return 1;
  }
  const formatArg = parseFlag(args, "--format") ?? "xml";
  if (formatArg !== "xml" && formatArg !== "markdown") {
    console.error(`ambix brief: invalid --format: ${formatArg} (expected xml or markdown)`);
    return 1;
  }
  const outputArg = parseFlag(args, "--output");

  let sessionPath: string;
  try {
    sessionPath = await resolveSessionPath(sessionArg);
  } catch (err) {
    console.error(`ambix brief: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const session = new Session(sessionPath);
  const { content, stats } = await buildBrief(session, { format: formatArg });

  if (outputArg) {
    await writeFile(outputArg, content, "utf8");
    console.error(
      `wrote brief (${formatArg}, ${stats.rounds} rounds, ${stats.toolUses} tool uses) to ${outputArg}`
    );
  } else {
    process.stdout.write(content);
  }
  return 0;
}

async function runCompact(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.error(
      "usage: ambix compact <session-path-or-id> [--full-recent N] [--output <path>] [--dry-run]"
    );
    console.error("");
    console.error("Produce a resumable compacted session JSONL. The last N rounds are preserved");
    console.error("verbatim; older turns are collapsed into ONE user-role message containing an");
    console.error("<ambix-compaction-marker> preamble plus a <turns> XML list with per-tool");
    console.error("structured children. Tool_use input fields over --max-field-bytes get a");
    console.error('`truncated="<bytes>"` attribute + preview body; full content is rehydratable');
    console.error("via `ambix query <orig-session-id> <ix>`.");
    console.error("");
    console.error("The compacted session gets a fresh UUID and, by default, lands in CC's");
    console.error("project dir for the source's cwd so it appears in /resume.");
    console.error("");
    console.error("  <session-path-or-id>  path to a .jsonl file, or a session UUID (or prefix)");
    console.error("");
    console.error("flags:");
    console.error("  --full-recent N       rounds to preserve verbatim at the tail (default: 10)");
    console.error(
      "  --max-field-bytes N   truncate any condensed string field over N bytes (default: 500)"
    );
    console.error(
      "  --preview-chars N     keep first N chars of truncated fields as preview (default: 100, 0 disables)"
    );
    console.error("  --preserve <kind>:<pattern>");
    console.error("                        preserve matching entries verbatim (repeatable).");
    console.error("                        tool:<glob>   — matched tool_use/tool_result render");
    console.error("                                        verbatim inside the bundled summary");
    console.error("                                        (no truncation, real result bodies)");
    console.error("                        type:<glob>   — matched entries pass through as real");
    console.error("                                        JSONL entries (like Task* entries do)");
    console.error("                        glob: * matches any sequence, ? matches one char;");
    console.error("                        case-sensitive whole-name match.");
    console.error("  --output <path>       override destination path");
    console.error("  --dry-run             print the plan without writing");
    return 0;
  }
  const sessionArg = args[0];
  if (!sessionArg) {
    console.error("ambix compact: missing <session-path-or-id>");
    console.error(
      "usage: ambix compact <session-path-or-id> [--full-recent N] [--output <path>] [--dry-run]"
    );
    return 1;
  }

  const fullRecentArg = parseFlag(args, "--full-recent");
  let fullRecent: number | undefined;
  if (fullRecentArg !== undefined) {
    fullRecent = Number.parseInt(fullRecentArg, 10);
    if (Number.isNaN(fullRecent) || fullRecent < 0) {
      console.error(`ambix compact: invalid --full-recent: ${fullRecentArg}`);
      return 1;
    }
  }
  const maxFieldBytesArg = parseFlag(args, "--max-field-bytes");
  let maxFieldBytes: number | undefined;
  if (maxFieldBytesArg !== undefined) {
    maxFieldBytes = Number.parseInt(maxFieldBytesArg, 10);
    if (Number.isNaN(maxFieldBytes) || maxFieldBytes < 0) {
      console.error(`ambix compact: invalid --max-field-bytes: ${maxFieldBytesArg}`);
      return 1;
    }
  }
  const previewCharsArg = parseFlag(args, "--preview-chars");
  let previewChars: number | undefined;
  if (previewCharsArg !== undefined) {
    previewChars = Number.parseInt(previewCharsArg, 10);
    if (Number.isNaN(previewChars) || previewChars < 0) {
      console.error(`ambix compact: invalid --preview-chars: ${previewCharsArg}`);
      return 1;
    }
  }
  const output = parseFlag(args, "--output");
  const dryRun = args.includes("--dry-run");
  const preserveSelectors = parseRepeatedFlag(args, "--preserve");

  let sessionPath: string;
  try {
    sessionPath = await resolveSessionPath(sessionArg);
  } catch (err) {
    console.error(`ambix compact: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const session = new Session(sessionPath);
  let result: Awaited<ReturnType<typeof compactSession>>;
  try {
    result = await compactSession(session, {
      fullRecent,
      output,
      dryRun,
      maxFieldBytes,
      previewChars,
      preserveSelectors,
    });
  } catch (err) {
    // Surface selector-parse errors (and any other call-time failures)
    // with the `ambix compact:` prefix so the user sees which subcommand
    // rejected their flags.
    console.error(`ambix compact: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const prefix = result.dryRun ? "[dry-run] would write" : "wrote";
  const preservedBits: string[] = [];
  if (result.stats.userPreservedToolCount > 0) {
    preservedBits.push(`${result.stats.userPreservedToolCount} user-preserved tool calls`);
  }
  if (result.stats.userPreservedTypeCount > 0) {
    preservedBits.push(`${result.stats.userPreservedTypeCount} user-preserved type entries`);
  }
  const preservedSuffix = preservedBits.length > 0 ? `, ${preservedBits.join(", ")}` : "";
  console.error(
    `${prefix} compacted session to ${result.destPath} ` +
      `(${result.stats.sourceEntryCount} source → ` +
      `${result.stats.bundledTurnCount} bundled turns + ` +
      `${result.stats.preservedEntryCount} preserved + ` +
      `${result.stats.droppedEntryCount} dropped, ` +
      `${result.stats.stubbedToolResultCount} tool_result stubs, ` +
      `${result.stats.truncatedInputFieldCount} fields truncated${preservedSuffix}, ` +
      `~${result.stats.bytesSaved} bytes saved)`
  );
  if (result.copiedTasksDir) {
    console.error(`copied tasks dir: ${result.copiedTasksDir} (snapshot of source)`);
  }
  console.log(result.newSessionId);
  return 0;
}

async function runQueryCmd(args: string[]): Promise<number> {
  const { code, output } = await runQuery(args);
  process.stdout.write(output);
  return code;
}

function hasHelp(args: string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

/** Collect every occurrence of `--name value`. Useful for repeatable flags. */
function parseRepeatedFlag(args: string[], name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === name && args[i + 1] !== undefined) out.push(args[i + 1]);
  }
  return out;
}

function printUsage(): void {
  console.error("ambix — Claude Code session distillation pipeline");
  console.error("");
  console.error("usage: ambix <subcommand> [args]");
  console.error("");
  console.error("subcommands:");
  console.error(
    "  distill  <session-path-or-id>    run the full pipeline (stage → analyze → distill → merge)"
  );
  console.error(
    "  analyze  <session-path-or-id>    deterministic analysis only (prints JSON to stdout)"
  );
  console.error(
    "  info     <session-path-or-id>    minimal session summary (metadata + token rollup)"
  );
  console.error(
    "  stage    <session-path-or-id>    stage a session into a tmp workspace (prints layout JSON)"
  );
  console.error(
    "  brief    <session-path-or-id>    chronological per-round summary for context recovery"
  );
  console.error(
    "  compact  <session-path-or-id>    emit a resumable compacted JSONL (stubs + divider + preserved tail)"
  );
  console.error(
    "  file-at  <path> <ix>             print a tracked file's content at a given turn index"
  );
  console.error(
    "  query    <session> [sub]         search a session log; bare ix works: `query <session> 42`"
  );
  console.error("  help                             show this message");
  console.error("");
  console.error("Run 'ambix <subcommand> --help' for subcommand-specific flags.");
  console.error("");
  console.error(
    "Note: stage, file-at, and query are primarily tools that the staged distiller agent"
  );
  console.error(
    "calls during a distill run. distill, analyze, and brief are the human-facing entry points."
  );
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
);
