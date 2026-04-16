# CLI Reference

All subcommands accept `--help` / `-h`. Session arguments can be an absolute path to a `.jsonl` file, a relative path, or a session UUID (or unique prefix) which is resolved by scanning `~/.claude/projects`.

## distill

Run the full pipeline: stage, analyze, distill (agent), merge, persist.

```
ambix distill <session-path-or-id> [flags]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--output <root>` | `~/.ambix` | Artifact output root |
| `--tmp-root <dir>` | `$TMPDIR/ambix` | Tmp workspace root |
| `--keep-tmp` | off | Retain tmp dir on success (always retained on failure) |
| `--mock` | off | Use MockAgentRunner (skips API calls) |
| `--model <id>` | `claude-sonnet-4-6` | Model ID for RealAgentRunner |
| `--max-inline-bytes <N>` | `2048` | Inline budget in bytes for condensed entries |
| `-v`, `--verbose` | off | Print condensation report to stderr before distill |

On success, prints the artifact path and a token usage summary comparing source session tokens to distiller tokens.

## analyze

Deterministic analysis only. Prints `AnalyzeResult` JSON to stdout.

```
ambix analyze <session-path-or-id>
```

No additional flags. Output includes token totals, tool usage counts, file churn, bash clusters, failures, subagent records, and permission events.

## stage

Stage a session into a tmp workspace. Prints `StageLayout` JSON to stdout.

```
ambix stage <session-path-or-id> [flags]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--tmp <dir>` | `$TMPDIR/ambix-<pid>` | Tmp workspace root |
| `--max-inline-bytes <N>` | `2048` | Inline budget in bytes |
| `-v`, `--verbose` | off | Print condensation report to stderr |

## compact

Produce a chronological, per-round summary of a session for context recovery.

```
ambix compact <session-path-or-id> [--format xml|markdown] [--output <file>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--format xml\|markdown` | `xml` | Output format |
| `--output <file>` | stdout | Write to file instead of stdout |

Each round, tool_use, and assistant text block is tagged with a rehydration index (the `ix` that `ambix query <session> show <ix>` resolves). An agent loading the compact output can pull full details for any entry on demand.

## file-at

Print a tracked file's content as it existed at a given turn index.

```
ambix file-at <path> <ix> [--tmp <dir>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--tmp <dir>` | cwd | Staged tmp directory |

Resolves the file from the `file-history/snapshots.json` index in the staged workspace, returning the version that was current at turn `<ix>`.

## query

Search a session log without reading the whole file.

```
ambix query <session> <subcommand> [options]
```

Shorthand: `ambix query <session> 42` is rewritten to `show 42`.

### Format flags

These apply to all subcommands except `show`:

| Flag | Description |
|------|-------------|
| `--full` | Full JSON, one object per line |
| `--count` | Match count only |
| *(default)* | Compact one-line-per-match summaries |

### Subcommands

#### show

```
ambix query <session> show <ix> [--field <path>]
```

Show the full entry at turn index `<ix>`, or extract a single field via dot/bracket notation.

```bash
# full entry at turn 12
ambix query session.jsonl show 12

# just the file path from a Write tool_use
ambix query session.jsonl show 12 --field message.content[0].input.file_path
```

#### tool-uses

```
ambix query <session> tool-uses [--name <tool>]
```

List all `tool_use` blocks. Optionally filter by exact tool name.

```bash
ambix query session.jsonl tool-uses --name Bash
```

#### tool-results

```
ambix query <session> tool-results [--error] [--tool-use-id <id>]
```

List `tool_result` blocks. `--error` restricts to results with `is_error=true`. `--tool-use-id` filters to a specific tool use.

```bash
ambix query session.jsonl tool-results --error
```

#### text-search

```
ambix query <session> text-search <pattern> [--role user|assistant]
```

Case-sensitive substring search across text content blocks. `--role` restricts to user or assistant entries.

```bash
ambix query session.jsonl text-search "permission denied" --role assistant
```
