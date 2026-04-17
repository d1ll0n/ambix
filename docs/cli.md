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

## info

Minimal session summary: structural metadata plus a token rollup (totals + per-model). Cheaper than `analyze` — no tools/files/churn scan.

```
ambix info <session-path-or-id> [--json]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--json` | off | Emit `SessionInfo` JSON instead of the human-readable block |

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

## brief

Produce a chronological, per-round summary of a session for context recovery.

```
ambix brief <session-path-or-id> [--format xml|markdown] [--output <file>]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--format xml\|markdown` | `xml` | Output format |
| `--output <file>` | stdout | Write to file instead of stdout |

Each round, tool_use, and assistant text block is tagged with a rehydration index (the `ix` that `ambix query <session> show <ix>` resolves). An agent loading the brief output can pull full details for any entry on demand.

## compact

Emit a new resumable session JSONL with older turns condensed and the last N rounds preserved verbatim. Alternative to Claude Code's built-in `/compact`, which replaces prior history with a narrative summary in place; this produces a new resumable session file that preserves turn structure with rehydration pointers.

```
ambix compact <session-path-or-id> [--full-recent N] [--output <path>] [--dry-run]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--full-recent N` | `10` | Rounds preserved verbatim at the tail |
| `--output <path>` | `~/.claude/projects/<source-slug>/<new-uuid>.jsonl` | Destination path |
| `--dry-run` | off | Print the plan and stats without writing |

**Output layout:** the emitted file has three sections —
1. Condensed pre-compaction turns: user/assistant/tool_use entries retained as real entries; each tool_result's `content` is replaced with `[COMPACTION STUB — <tool-summary>, ~N bytes removed. Retrieve via: ambix query <orig-session-id> <ix>]`.
2. A single `isCompactSummary: true` user entry as the divider, explaining what's above and below.
3. The last N rounds preserved verbatim.

**Destination default** places the new session in the same CC project slug as the source, so it appears in CC's `/resume` list when the user is in the source's cwd. On success, the new session UUID is printed to stdout; a plan summary is printed to stderr.

**Tasks dir snapshot.** If the source session has a per-session tasks directory (`~/.claude/tasks/<orig-session-id>/`), it's deep-copied to the new session's tasks dir (`~/.claude/tasks/<new-session-id>/`) so the compacted session starts with the same task state. The copy is independent: later `TaskCreate` / `TaskUpdate` calls on the compacted session don't mutate the source's tasks, and vice versa — source sessions can still be continued or forked cleanly. No-op when the source has no tasks dir.

**Rehydration:** when Claude resumes into a compacted session and encounters a stub, it can run the embedded `ambix query` command to retrieve the original pre-compaction tool output. Empirically validated against Claude Code 2.1.110 — see `docs/specs/2026-04-17-compact-to-session.md`.

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
