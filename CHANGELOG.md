# Changelog

All notable changes to ambix are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project aims to loosely follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.0] - 2026-04-17

### Added
- **New `ambix compact <session>` subcommand** (a different feature from the
  one that shipped with this name in 0.1.0 — that one is now `ambix brief`).
  Produces a resumable compacted session JSONL. The last `--full-recent N`
  rounds pass through verbatim; older turns collapse into a single
  user-role message containing an `<ambix-compaction-marker>` preamble +
  `<turns>` XML list with per-tool structured children (`<file_path>`,
  `<old_string>`, `<command>`, `<prompt>`, etc.). Fields over
  `--max-field-bytes` get a `truncated="<bytes>"` attribute and a short
  preview body; full content is rehydratable via
  `ambix query <orig-session-id> <ix>`. The output lands in the source's
  CC project slug so `/resume` picks it up. Alternative to CC's built-in
  `/compact` for when you want a structured navigable history rather than
  a narrative summary.
- **`--preserve <kind>:<pattern>` flag** (repeatable). Exempts matching
  entries from condensation.
  `tool:<glob>` keeps matching tool_use input fields + tool_result body
  verbatim inside the bundled XML — useful when a tool IS the user-visible
  channel (e.g. an MCP Telegram plugin whose tool_use is the outgoing
  message). `type:<glob>` promotes matching entries to real JSONL
  pass-through, same path Task* entries take (e.g.
  `type:file-history-snapshot` to keep CC rewind-with-code working through
  the condensed range). Glob: `*` matches any sequence, `?` matches one
  char; case-sensitive whole-name match.
- **Task\* sidecar pass-through.** `TaskCreate` / `TaskUpdate` /
  `TaskGet` / `TaskList` / `TaskOutput` / `TaskStop` tool_use + matched
  tool_result entries pass through as real JSONL entries rather than
  being folded into the bundled XML. CC replays these on resume to
  rebuild its live task list.
- **Tasks-directory snapshot.** `~/.claude/tasks/<orig-sid>/` is
  deep-copied (symlink-dereferenced) to the new session's tasks dir so
  task state carries forward. UUID-validated against path traversal;
  atomic write via `.tmp` + `O_EXCL` + rename with rollback on failure.
  Uses parse-cc 0.2.0's new tasks-dir discovery helpers.
- **`ambix info <session>` subcommand.** Lightweight summary of a session:
  metadata (session_id, cwd, branch, turn count, duration, end state) +
  token rollup (totals + per-model input/output/cache_read/cache_write).
  Cheaper than `analyze` — no tools/files/churn scan. `--json` for
  machine-readable output.
- **Type-aware `ambix query <session> <ix>` output.** Default rendering
  strips CC's JSON envelope (`parentUuid`, `promptId`, `usage`, etc.)
  and real-newlines the content so `grep` works. `<persisted-output>`
  spill wrappers surface as `[spilled to <path> — <size>]` + preview.
  `--raw` opts into the old envelope form; `--field <path>` still
  returns raw values at the path.
- **`ambix brief <session>`** — the pre-0.2.0 `ambix compact` subcommand,
  renamed. Markdown/XML chronological per-round summary for humans /
  agents reading a session. Semantics unchanged.

### Changed
- **parse-cc bumped to `^0.2.0`** for `defaultTasksDir` / `findTasksDir` /
  `listTasks`.
- **Metadata end_state heuristic.** A session with a user turn but no
  assistant response now reports `end_state: "unknown"` rather than
  `"completed"`.
- **File-history snapshot bytes populated.** `snapshots.json` entries
  now carry an accurate `bytes` field (was always `null`).

### Fixed
- `src/agent/runner-real.ts::aggregateResultTokens` now prefers the SDK's
  `modelUsage` (per-model multi-turn totals) over `result.usage`
  (last-turn only); fallback preserved for SDK versions without it.
- `ambix analyze` / `compact` / `brief` / `info` / `distill` / `stage`
  all route session IDs through `parse-cc::findAllSessions` via
  `resolveSessionPath`, so bare UUIDs or unambiguous UUID prefixes work
  the same as file paths. Ambiguous prefixes error out with the list of
  matches.

### Removed
- **Incorrectly-shipped `structural` mode for `ambix compact`.** A
  previous iteration of this PR offered `--mode structural` that kept
  every condensed entry as a real JSONL entry with `[COMPACTION STUB]`
  strings replacing tool_result bodies. Smoke testing revealed that
  shape matched CC harness's in-context display-trimming pattern exactly,
  causing agents to echo stub text into new tool calls during normal
  work. The code moved to `src/compact-session/_experimental/structural/`
  with a `DEPRECATED.md` explaining the failure. The `--mode` CLI flag
  was removed; `ambix compact` now runs bundled unconditionally.

## [0.1.0] - 2026-04-16

### Added
- **`ambix compact <session>` subcommand.** Produces a chronological,
  per-round summary of a session intended as a drop-in replacement for
  Claude Code's built-in `/compact` output when starting a new session
  from a previous one. Each round contains the human prompt, assistant
  text blocks, and condensed per-tool one-liners (file paths with line
  /token counts for Read, diff-stat for Edit, line counts for Write,
  match counts for Grep/Glob, truncated command + result size + git
  commit annotation for Bash, and similar for Task, TodoWrite,
  playwright MCP calls, etc.). Every element carries a rehydration
  index: `<user idx="N">`, `<assistant idx="N">`, `<tools idx="A-B">`
  with per-line `[ix]` prefixes — so a new session can load the compact
  output and fetch full details for any specific turn via
  `ambix query <session> <ix>`. XML is the default format (best for
  model consumption); `--format markdown` is available for human
  browsing. `--output <file>` writes to a file instead of stdout.
- **`ambix query` accepts session IDs.** The query subcommand now
  routes through the global `resolveSessionPath`, so bare UUIDs and
  UUID prefixes work the same way they do for stage / analyze /
  distill / compact. Existing `metadata.json`-based `query_targets`
  resolution (staged-workspace mode used by the distiller agent)
  still takes priority.
- **`ambix query <session> <N>` bare-integer shortcut.** A numeric
  second argument is rewritten internally to `show <N>`. Keeps
  subsequent flags like `--field message.content[0].input.content`
  working, and makes the CLI call implied by `compact` output as
  short as possible.
- **Git branch change markers** in compact output. `<git branch="..."/>`
  fires on the first round and on any round where the session's branch
  differs from the previous round. Silent when the branch is stable
  for the whole session.
- **Git commit annotations on Bash lines** in compact output. When a
  Bash tool_result contains the `[branch shortHash] subject` line that
  `git commit` emits on success, the tool line gets
  `→ commit <hash> '<subject>'` appended.
- **Wrapper-round filtering** in compact. Rounds whose entire user
  message is harness scaffolding (`<local-command-caveat>`,
  `<command-name>/clear</command-name>`, `<system-reminder>`-only) are
  filtered out; `rawRounds` vs `rounds` in `CompactStats` exposes both
  counts for diagnostics.
- **Session ID resolution.** `ambix stage`, `ambix analyze`, and
  `ambix distill` now accept a session UUID or unambiguous UUID prefix
  in addition to a `.jsonl` path. Resolution runs through
  `findAllSessions` across `~/.claude/projects`; ambiguous prefixes
  error with the list of matching sessions.
- **Inline condensed session in the distiller's initial message.** When
  the staged `session.jsonl` is under 200 KB, its contents and
  `metadata.json` are embedded directly into the agent's first user
  message so the distiller never has to spend a tool round-trip reading
  them. Oversized sessions fall back to the previous "read it yourself
  with pagination" flow.
- **New system-prompt Workflow section** with an explicit step-by-step
  loop and anti-patterns (no iterating turns via `bin/query show 0`,
  `show 1`, ...). `bin/query` framing rewritten to position it strictly
  as a filter/extract helper.
- **`--max-inline-bytes <N>`** flag on both `ambix stage` and
  `ambix distill` to override the inline size budget for tool_results,
  text blocks, and per-field tool_use inputs (default 2048).
- **`-v` / `--verbose`** flag on both `ambix stage` and `ambix distill`.
  Prints a per-kind condensation report to stderr showing, for each
  content bucket (`tool_use:<name>`, `tool_result:<name>`,
  `assistant:text`, `assistant:thinking`, `user:text`, `other:<type>`),
  the count, original KB, inlined KB, and truncated fraction — sorted
  by original byte size descending.
- **`CondenseStats` + `condenseEntriesWithStats`** exports from
  `src/stage/condense.ts` for programmatic access to the same report.
- **`truncateLargeStringsDeep` helper** that recursively walks any value
  and stubs strings exceeding `maxInlineBytes`. Applied to non-message
  entry payloads (attachment, system, summary, last-prompt,
  queue-operation, progress, etc.), the tool_result content catch-all,
  thinking-block signatures, image `source.data`, and unknown blocks.
  Closes every remaining string field that could grow without bound.

### Changed
- **`DEFAULT_MAX_TURNS`** in `RealAgentRunner` lowered from 100 → 40.
- **Condense stats bucketing fixed.** Text blocks nested inside a
  tool_result's array content were previously being recorded under
  `assistant:text` in addition to the outer `tool_result:<name>` bucket.
  `condenseBlock` now takes an explicit `recordStats` flag that is
  `false` during inner tool_result walks.
- On a 448-tool-call playwright session, total condensed bytes dropped
  from ~1540 KB to ~745 KB (52% compression), with attachment payloads
  alone saving ~130 KB once deep truncation was applied.

### Tests
- 202/202 passing (157 original + 12 stats/truncation tests + 33 new
  compact tests covering per-tool condensers, diff-stat edge cases,
  git commit extraction, branch change markers, idx range computation,
  wrapper-round filtering, XML and markdown variants).
