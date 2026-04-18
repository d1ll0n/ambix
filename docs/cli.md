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

Emit a new resumable session JSONL with older turns condensed and the last N rounds preserved verbatim. Alternative to Claude Code's built-in `/compact`, which replaces prior history with a narrative summary in place; this produces a new resumable session file with rehydration pointers.

```
ambix compact <session-path-or-id> [--full-recent N] [--max-field-bytes N]
                                   [--preview-chars N] [--output <path>] [--dry-run]
```

| Flag | Default | Description |
|------|---------|-------------|
| `--full-recent N` | `10` | Rounds preserved verbatim at the tail |
| `--max-field-bytes N` | `500` | Truncate any condensed string field above this UTF-8 byte count |
| `--preview-chars N` | `100` | Chars of the original kept as preview inside the truncation marker (`0` disables the preview) |
| `--preserve <kind>:<pattern>` | (none) | Preserve matching entries verbatim. Repeatable. See Preserve selectors below. |
| `--output <path>` | `~/.claude/projects/<source-slug>/<new-uuid>.jsonl` | Destination path |
| `--dry-run` | off | Print the plan and stats without writing |

**Output layout.**

```
[ONE user-role message]   ← <ambix-compaction-marker> preamble
                              + <turns> XML list with per-tool structured children
[Task* pass-throughs]     ← TaskCreate/Update/… tool_use + matched tool_result
                              entries preserved VERBATIM (CC replay on resume)
[preserved tail]          ← last --full-recent rounds verbatim
```

Each `<tool_use>` inside the bundled message has per-tool element children (`<file_path>`, `<old_string>`, `<command>`, `<prompt>`, etc.) — the renderer dispatches on tool name and knows which fields are scalar vs. truncatable. Fields over `--max-field-bytes` get a `truncated="<bytes>"` attribute + short preview body ending with `…`:

```xml
<tool_use name="Edit" ix="47">
  <file_path>src/foo.ts</file_path>
  <old_string truncated="2048">function foo() {…</old_string>
  <new_string truncated="2103">function foo(x: number) {…</new_string>
</tool_use>
<tool_result ix="48" name="Edit">+12 -5 hunks</tool_result>
```

Conversational user/assistant text blocks pass through verbatim (no `--max-field-bytes` cap — only a 16 KB sanity clamp for truly unreasonable blocks, which becomes `<truncated_text bytes="N" ix="M">preview…</truncated_text>`).

**Task* sidecar pass-through.** `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` / `TaskOutput` / `TaskStop` tool_use entries and their matched tool_result entries pass through verbatim as real JSONL entries (not summarized into the bundled XML). CC replays these on resume to rebuild its live task list; redacting or restructuring them would break task-state restoration.

**Preserve selectors.** `--preserve <kind>:<pattern>` exempts matching entries from condensation. Repeatable. Two kinds supported:

| Kind | Matches | Effect |
|---|---|---|
| `tool:<glob>` | tool_use.name (on assistant entries) or the tool_name of a tool_result (via tool_use_id lookup) | Entry stays inside the bundled `<turns>` block; tool_use input fields pass through verbatim (no truncation); tool_result renders with the real `block.content` as body instead of the condenser one-liner |
| `type:<glob>` | parse-cc's `entry.type` field | The whole entry passes through as a real JSONL entry, exactly like Task* entries do — parentUuid rewired, routing IDs regenerated, payload untouched |

Glob: `*` matches any sequence, `?` matches one char. Case-sensitive, whole-name match.

```bash
# Preserve an MCP telegram plugin's tool calls (so the resumed agent sees the
# actual messages, not "sent — message_id 42" summaries):
ambix compact <session> --preserve 'tool:mcp__plugin_telegram__*'

# Preserve file-history-snapshot entries (default behavior drops them; override
# to keep CC rewind-with-code functional for the condensed range):
ambix compact <session> --preserve 'type:file-history-snapshot'

# Combine:
ambix compact <session> \
  --preserve 'tool:mcp__plugin_telegram__*' \
  --preserve 'tool:mcp__plugin_slack__*' \
  --preserve 'type:custom-title'
```

When any `--preserve` selectors are active, the bundled message's preamble tells the resumed agent which patterns to expect so it knows preserved content is real (not a stub to rehydrate).

**Destination default** places the new session in the same CC project slug as the source, so it appears in CC's `/resume` list when the user is in the source's cwd. On success, the new session UUID is printed to stdout; a plan summary (entry counts, truncation stats, bytes saved) is printed to stderr.

**Tasks dir snapshot.** If the source session has a per-session tasks directory (`~/.claude/tasks/<orig-session-id>/`), it's deep-copied to the new session's tasks dir (`~/.claude/tasks/<new-session-id>/`) so the compacted session starts with the same task state. The copy is independent: later `TaskCreate` / `TaskUpdate` calls on the compacted session don't mutate the source's tasks, and vice versa.

**Rehydration:** when Claude resumes into a compacted session and needs the original content of any condensed turn, it runs `ambix query <orig-session-id> N` — the preamble tells the agent once how to do this, and every `<turn>`, `<tool_use>`, and `<tool_result>` element carries the `ix` attribute it needs. Empirically validated against Claude Code 2.1.112 — see `docs/specs/2026-04-17-compact-to-session.md`.

**Known limitation:** CC's "restore conversation and code" rewind feature reconstructs file state from `file-history-snapshot` entries, which ambix drops from the condensed range. Rewind-with-code from a compacted session can only reach into the preserved tail.

**Why not a per-entry "structural" layout?** An earlier design emitted every condensed entry as a real JSONL log entry with tool_result bodies swapped for `[COMPACTION STUB — …]` strings and tool_use inputs wrapped in `<truncated>…</truncated>{marker}` syntax. Real-session smoke testing revealed that shape was identical to how CC's harness trims in-context display of prior tool_use values — the agent would pattern-match the trimmed display back into new tool calls, silently writing literal stub text into files it Edited. The bundled per-tool XML shape (distinct from CC's internal tool_use JSON AND distinct from the harness's truncation display) is the replacement. The structural emitter is parked under `src/compact-session/_experimental/structural/` for reference; see its `DEPRECATED.md`.

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
