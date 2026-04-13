#!/usr/bin/env node
// src/cli.ts
import { Session } from "parse-claude-logs";
import { stage } from "./stage/index.js";
import { fileAt } from "./file-at.js";
import { analyze } from "./analyze/index.js";

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
  const sessionArg = args[0];
  if (!sessionArg) {
    console.error("alembic analyze: missing <session-path>");
    console.error("usage: alembic analyze <session-path>");
    return 1;
  }
  const session = new Session(sessionArg);
  const result = await analyze(session);
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  return 0;
}

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function printUsage(): void {
  console.error("usage: alembic <subcommand> [args]");
  console.error("");
  console.error("subcommands:");
  console.error("  stage <session-path> [--tmp <dir>]   stage a session into a tmp dir");
  console.error("  file-at <path> <ix> [--tmp <dir>]    print a tracked file's content at a turn");
  console.error("  analyze <session-path>                 print deterministic analysis JSON");
  console.error("  help                                  show this message");
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
);
