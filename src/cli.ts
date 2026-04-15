#!/usr/bin/env node
// src/cli.ts
import { Session } from "parse-claude-logs";
import { MockAgentRunner } from "./agent/runner-mock.js";
import { RealAgentRunner } from "./agent/runner-real.js";
import { analyze } from "./analyze/index.js";
import { fileAt } from "./file-at.js";
import { run } from "./orchestrate/run.js";
import { runQuery } from "./query/index.js";
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
    case "distill":
      return runDistill(rest);
    case "query":
      return runQueryCmd(rest);
    case "--help":
    case "-h":
    case "help":
      printUsage();
      return 0;
    default:
      console.error(`alembic: unknown subcommand: ${subcommand}`);
      printUsage();
      return 1;
  }
}

async function runStage(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.error("usage: alembic stage <session-path> [--tmp <tmp-dir>]");
    console.error("");
    console.error("Stage a session into a tmp workspace. Prints the StageLayout JSON on success.");
    console.error("");
    console.error("flags:");
    console.error("  --tmp <dir>   tmp workspace root (default: $TMPDIR/alembic-<pid>)");
    return 0;
  }
  const sessionArg = args[0];
  const tmpArg = parseFlag(args, "--tmp");
  if (!sessionArg) {
    console.error("alembic stage: missing <session-path>");
    console.error("usage: alembic stage <session-path> [--tmp <tmp-dir>]");
    return 1;
  }
  const session = new Session(sessionArg);
  const tmpDir = tmpArg ?? `${process.env.TMPDIR ?? "/tmp"}/alembic-${process.pid}`;
  const layout = await stage(session, tmpDir);
  console.log(JSON.stringify(layout, null, 2));
  return 0;
}

async function runFileAt(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.error("usage: alembic file-at <path> <ix> [--tmp <tmp-dir>]");
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
    console.error("alembic file-at: missing arguments");
    console.error("usage: alembic file-at <path> <ix> [--tmp <tmp-dir>]");
    return 1;
  }
  const ix = Number.parseInt(ixStr, 10);
  if (Number.isNaN(ix)) {
    console.error(`alembic file-at: invalid ix: ${ixStr}`);
    return 1;
  }
  const tmp = tmpArg ?? process.cwd();
  const result = await fileAt({ tmp, path: filePath, ix });
  process.stdout.write(result.content);
  return 0;
}

async function runAnalyze(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.error("usage: alembic analyze <session-path>");
    console.error("");
    console.error("Deterministic analysis over a session. Prints AnalyzeResult JSON to stdout.");
    return 0;
  }
  const sessionArg = args[0];
  if (!sessionArg) {
    console.error("alembic analyze: missing <session-path>");
    console.error("usage: alembic analyze <session-path>");
    return 1;
  }
  const session = new Session(sessionArg);
  const result = await analyze(session);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return 0;
}

async function runDistill(args: string[]): Promise<number> {
  if (hasHelp(args)) {
    console.error("usage: alembic distill <session-path> [flags]");
    console.error("");
    console.error("Run the full pipeline: stage → analyze → distill → merge → persist.");
    console.error("");
    console.error("flags:");
    console.error("  --output <root>    artifact output root (default: ~/.alembic)");
    console.error("  --tmp-root <dir>   tmp workspace root (default: $TMPDIR/alembic)");
    console.error("  --keep-tmp         retain tmp dir on success (always retained on failure)");
    console.error("  --mock             use MockAgentRunner (skips API calls)");
    console.error("  --model <id>       model ID passed to RealAgentRunner");
    return 0;
  }
  const sessionArg = args[0];
  if (!sessionArg) {
    console.error("alembic distill: missing <session-path>");
    console.error(
      "usage: alembic distill <session-path> [--output <root>] [--tmp-root <dir>] [--keep-tmp] [--mock] [--model <id>]"
    );
    return 1;
  }
  const outputRoot = parseFlag(args, "--output");
  const tmpRoot = parseFlag(args, "--tmp-root");
  const keepTmp = args.includes("--keep-tmp");
  const useMock = args.includes("--mock");
  const model = parseFlag(args, "--model");

  const runner = useMock ? new MockAgentRunner() : new RealAgentRunner({ model });

  const result = await run({
    session: sessionArg,
    outputRoot,
    tmpRoot,
    runner,
    keepTmp,
  });

  if (!result.success) {
    console.error("alembic distill: failed");
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

function printUsage(): void {
  console.error("alembic — Claude Code session distillation pipeline");
  console.error("");
  console.error("usage: alembic <subcommand> [args]");
  console.error("");
  console.error("subcommands:");
  console.error(
    "  distill  <session-path>    run the full pipeline (stage → analyze → distill → merge)"
  );
  console.error("  analyze  <session-path>    deterministic analysis only (prints JSON to stdout)");
  console.error(
    "  stage    <session-path>    stage a session into a tmp workspace (prints layout JSON)"
  );
  console.error(
    "  file-at  <path> <ix>       print a tracked file's content at a given turn index"
  );
  console.error("  query    <session> <sub>   search within a session log (see 'query --help')");
  console.error("  help                       show this message");
  console.error("");
  console.error("Run 'alembic <subcommand> --help' for subcommand-specific flags.");
  console.error("");
  console.error(
    "Note: stage, file-at, and query are primarily tools that the staged distiller agent"
  );
  console.error(
    "calls during a distill run. distill and analyze are the human-facing entry points."
  );
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
);
