// src/query/index.ts
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { Session } from "parse-cc";
import { resolveSessionPath as resolveGlobalSessionPath } from "../orchestrate/resolve.js";
import { formatMatches } from "./format.js";
import { queryShow } from "./show.js";
import { queryTextSearch } from "./text-search.js";
import { queryToolResults } from "./tool-results.js";
import { queryToolUses } from "./tool-uses.js";
import type { QueryOutputFormat } from "./types.js";

/**
 * Resolve a session argument to a `.jsonl` path.
 *
 * Priority:
 *   1. If cwd has a `metadata.json` with a matching `query_targets` entry,
 *      use that (staged-workspace mode — the distiller agent uses this).
 *   2. Otherwise delegate to the global resolver, which handles absolute
 *      paths, relative paths, and bare session UUIDs / UUID prefixes via
 *      `findAllSessions` across `~/.claude/projects`.
 */
async function resolveSessionPath(arg: string): Promise<string> {
  const metadataPath = path.join(process.cwd(), "metadata.json");
  try {
    await access(metadataPath);
    const meta = JSON.parse(await readFile(metadataPath, "utf8")) as {
      query_targets?: Record<string, string>;
    };
    if (meta.query_targets && typeof meta.query_targets[arg] === "string") {
      return meta.query_targets[arg];
    }
  } catch {
    // no metadata.json or unreadable — fall through
  }
  return await resolveGlobalSessionPath(arg);
}

/** Run one of the query subcommands and return a string to print. */
export async function runQuery(args: string[]): Promise<{ code: number; output: string }> {
  let [sessionPathArg, subcommand, ...rest] = args;
  if (!sessionPathArg || !subcommand || sessionPathArg === "--help" || sessionPathArg === "-h") {
    return { code: sessionPathArg ? 0 : 1, output: helpText() };
  }

  // Shorthand: `ambix query <session> 42` is rewritten to `show 42`.
  // Useful when the compaction XML emits `idx="N"` attributes — lets the
  // consuming agent rehydrate a specific entry with a bare-integer arg.
  if (/^\d+$/.test(subcommand)) {
    rest = [subcommand, ...rest];
    subcommand = "show";
  }

  const sessionPath = await resolveSessionPath(sessionPathArg);
  const session = new Session(sessionPath);
  const format = parseFormat(rest);

  switch (subcommand) {
    case "tool-uses": {
      const name = parseFlag(rest, "--name");
      const matches = await queryToolUses(session, { name });
      return { code: 0, output: formatMatches(matches, format) };
    }
    case "tool-results": {
      const error = rest.includes("--error");
      const toolUseId = parseFlag(rest, "--tool-use-id");
      const matches = await queryToolResults(session, { error, toolUseId });
      return { code: 0, output: formatMatches(matches, format) };
    }
    case "text-search": {
      const pattern = rest.find((a) => !a.startsWith("--"));
      if (!pattern) {
        return { code: 1, output: `text-search: missing <pattern>\n${helpText()}` };
      }
      const role = parseFlag(rest, "--role") as "user" | "assistant" | undefined;
      const matches = await queryTextSearch(session, { pattern, role });
      return { code: 0, output: formatMatches(matches, format) };
    }
    case "show": {
      const ixStr = rest.find((a) => !a.startsWith("--"));
      if (!ixStr) {
        return { code: 1, output: `show: missing <ix>\n${helpText()}` };
      }
      const ix = Number.parseInt(ixStr, 10);
      if (Number.isNaN(ix)) {
        return { code: 1, output: `show: invalid ix: ${ixStr}\n` };
      }
      const field = parseFlag(rest, "--field");
      const result = await queryShow(session, { ix, field });
      if (result === undefined) return { code: 0, output: "" };
      if (typeof result === "string") return { code: 0, output: `${result}\n` };
      return { code: 0, output: `${JSON.stringify(result, null, 2)}\n` };
    }
    case "--help":
    case "-h":
    case "help":
      return { code: 0, output: helpText() };
    default:
      return { code: 1, output: `unknown query subcommand: ${subcommand}\n${helpText()}` };
  }
}

function parseFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function parseFormat(args: string[]): QueryOutputFormat {
  if (args.includes("--full")) return "full";
  if (args.includes("--count")) return "count";
  return "compact";
}

function helpText(): string {
  return `usage: ambix query <session.jsonl> <subcommand> [options]

Search a Claude Code session log without reading the whole file.

Subcommands:
  tool-uses      [--name <N>]                    list tool_use blocks
  tool-results   [--error] [--tool-use-id <id>]  list tool_result blocks
  text-search    <pattern> [--role user|assistant]  substring search
  show           <ix> [--field <path>]           show entry (or one field) at ix

Format flags (any subcommand):
  --full     emit full JSON, one object per line
  --count    emit just the match count
  (default)  compact one-line-per-match summaries

## Common tool names and their key input fields

  Read:      input.file_path, input.offset, input.limit
  Write:     input.file_path, input.content
  Edit:      input.file_path, input.old_string, input.new_string
  MultiEdit: input.file_path, input.edits
  Bash:      input.command, input.description, input.timeout
  Grep:      input.pattern, input.path, input.glob, input.type
  Glob:      input.pattern, input.path
  Task:      input.subagent_type, input.description, input.prompt

## Common tool_result fields
  tool_use_id, content, is_error

## Common entry fields (for 'show --field')
  type, timestamp, uuid, parentUuid
  message.role, message.content, message.usage.input_tokens, message.usage.output_tokens

## Examples

  # find every Write call in a subagent log
  ambix query subagents/agent-abc/session.jsonl tool-uses --name Write

  # show the full content a Write wrote
  ambix query subagents/agent-abc/session.jsonl show 12 --field message.content[0].input.content

  # find errored tool_results in the parent session
  ambix query session.jsonl tool-results --error

  # substring search for "permission" in assistant text
  ambix query session.jsonl text-search permission --role assistant
`;
}
