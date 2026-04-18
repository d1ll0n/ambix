# Concepts

This document walks through the ambix pipeline in detail and describes the shape of the final artifact. For the high-level overview, see the [README](../README.md). For CLI flags, see the [CLI reference](cli.md).

## Pipeline

Ambix processes a Claude Code session JSONL file through four stages:

```
session.jsonl
    |
    v
+----------+     +----------+     +------------+     +-------------+
|  Stage   | --> | Analyze  | --> |  Distill   | --> | Merge +     |
|          |     |          |     |  (agent)   |     | Persist     |
+----------+     +----------+     +------------+     +-------------+
    |               |                  |                   |
    v               v                  v                   v
  tmp dir       AnalyzeResult     narrative.json      ~/.ambix/
```

### 1. Stage

`stage()` copies a session into a tmp workspace and produces a format the distiller agent can cheaply read. Given a `Session` and a `tmpDir`, it writes:

- `session.jsonl` -- the session's turns with large payloads replaced by rehydration stubs (truncated entries with a `ref`, byte count, token estimate, and preview).
- `turns/NNNNN.json` -- full JSON for any turn whose content was truncated inline.
- `spill/` -- large tool results copied from the source session's persisted output directory.
- `file-history/snapshots.json` + blob files -- a snapshot index and per-version content blobs for every file the session edited.
- `subagents/<agent-id>/` -- a condensed `session.jsonl` and optional `turns/` directory for every subagent spawned in the session (see [Subagent handling](#subagent-handling)).
- `metadata.json` -- session metadata (id, cwd, git branch, timestamps, turn count, end state).
- `out/` -- empty; the distiller writes `narrative.json` here.
- `bin/` -- wrapper scripts (`lint-output`, `query`, `file-at`) the distiller agent calls via Bash.

The inline budget is controlled by `--max-inline-bytes` (default 2048). Content larger than this becomes a stub with a preview so the agent can decide whether to rehydrate.

This layout is described by the `StageLayout` type.

### 2. Analyze

`analyze()` takes a `Session` and performs a deterministic pass that produces an `AnalyzeResult` containing:

- **tokens** -- per-model and aggregate token totals (`in`, `out`, `cache_read`, `cache_write`) plus a timeline of token density by turn.
- **tools** -- per-tool invocation counts.
- **files** -- tracked file records (read/edit/write counts per path, churn timeline).
- **bash_clusters** -- clusters of related bash invocations grouped by first-token pattern.
- **failures** -- tool-call failure records (turn index, tool name, input, error message).
- **subagents** -- records for every subagent spawned (agent ID, type, turn count, token usage).
- **spill_files** -- `SpillRecord` entries for large tool outputs stored on disk.
- **permission_events** -- permission mode transitions and grants.
- **compaction_phases** -- records of Claude Code's built-in context compaction events.

Analyze never calls the model -- it's pure data reduction over the parsed session.

### 3. Distill

`distill()` invokes an `AgentRunner` (either `RealAgentRunner` or `MockAgentRunner`) against the staged tmp directory. The agent's system prompt includes a tree view of the staged directory and instructions to produce a structured `Narrative` JSON document at `out/narrative.json`.

The runner's output is lint-gated: `lintNarrative` validates the JSON against the `Narrative` schema (required fields, valid enum values, valid turn index refs). If lint fails, distill retries up to `maxRetries` times (default 2) with the lint errors fed back to the agent as follow-up messages.

The distiller agent is expected to make ~3-5 tool calls plus ~1 per truncated turn it rehydrates. For each truncation stub, it checks the `preview` to decide whether the full content is worth reading. It uses `bin/query` for targeted searches rather than iterating through turns.

### 4. Merge + Persist

`mergeArtifact()` combines `metadata` (from stage), `deterministic` (from analyze), and `narrative` (from distill) into a single `Artifact`:

```typescript
interface Artifact {
  schema_version: "1";
  session_id: string;
  generated_at: string;
  metadata: MetadataJson;
  deterministic: AnalyzeResult;
  narrative: Narrative;
}
```

`persistArtifact()` writes the artifact to `~/.ambix/sessions/<session-id>/artifact.json` by default (override via `outputRoot`).

## Brief

Brief is a standalone capability, independent of the distillation pipeline. It produces a chronological per-round summary of a session suitable for context recovery by humans or agents.

```bash
ambix brief /path/to/session.jsonl
```

**How it works:**

1. Groups session entries into rounds (consecutive exchanges starting from a user message).
2. Filters out wrapper-only rounds (harness noise like system reminders, local-command wrappers).
3. Condenses each tool call into a one-liner summary via per-tool condensers (e.g., `Read src/main.ts (offset=0, limit=50) -- 50 lines, ~2k tok`).
4. Tags every tool call and assistant text block with a rehydration index (`ix`), the same index `ambix query <session> show <ix>` resolves.

**Output formats:**

- **XML** (default) -- `<round>`, `<user>`, `<tools>`, `<assistant>` tags. Primary format for LLM consumption.
- **Markdown** -- human-readable rendering of the same content.

**Condensers** produce one-liner summaries per tool type:

| Tool | Summary format |
|------|----------------|
| Read | `Read <path> (offset=N, limit=M) -- L lines, ~T tok` |
| Edit, NotebookEdit | `Edit <path> +added -deleted` |
| Write | `Write <path> -- L lines, ~T tok` |
| Bash | `` Bash `command` (description) -- ~T tok out `` |
| Grep | `Grep <pattern> in <path> -- N matches` |
| Glob | `Glob <pattern> -- N matches` |
| Task/Agent | `Task -> subagent_type: prompt -- ~T tok returned` |
| TodoWrite, TaskCreate, TaskUpdate, TaskList, TaskGet | `<Name> #<id> "<subject>" [status]` |
| Playwright tools | `<short_name>(key=value)` |
| *(other)* | Generic fallback: tool name + first string/number field |

## Compact

Compact produces a resumable compacted session JSONL from an existing session — an alternative to Claude Code's built-in `/compact`. Where `/compact` replaces prior history with a narrative summary and continues in place, `ambix compact` spawns a *new* session file with the same `cwd` / project slug so CC picks it up in `/resume`, and its on-disk layout trades bulk tool output for rehydration pointers.

```bash
ambix compact /path/to/session.jsonl --full-recent 10
```

**Output layout.** Three sections, in order:

1. **Bundled summary.** One user-role message whose content is an `<ambix-compaction-marker>` preamble followed by a `<turns>` XML block. Each condensed source entry becomes one `<turn ix="N" kind="...">` child; tool calls become `<tool_use name="X" ix="N">` elements with per-tool structured children (`<file_path>`, `<old_string>`, `<command>`, `<prompt>`, etc.). Tool results become `<tool_result ix="N" name="X">{condenser-summary}</tool_result>`. User/assistant text blocks pass through verbatim.
2. **Task\* sidecar entries.** `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` / `TaskOutput` / `TaskStop` tool_use + matched tool_result entries pass through verbatim as real JSONL entries. CC replays these on resume to rebuild its live task list; collapsing them into the bundled XML would break task-state restoration.
3. **Preserved tail.** The last `--full-recent N` rounds of the source, passed through verbatim (full tool_result bodies intact).

`file-history-snapshot` bookkeeping entries are dropped in the condensed range (CC never feeds them to the model on resume, and they commonly add 8+ KB apiece). **Caveat:** CC's "restore conversation and code" rewind feature uses these snapshots to restore file state; dropping them means rewind-with-code cannot reach any point inside the condensed range. Rewind back into the preserved tail still works.

**Tool_use field representation.** Per-tool handlers know which fields are always-scalar (file_path, command, offset) and which are candidates for truncation (Edit old/new_string, Write content, Task prompt). Small values pass through verbatim. Values over `--max-field-bytes` (default 500) get rendered as `<field truncated="<bytes>">preview…</field>` — attribute-based truncation signal, preview ends with `…`. Rehydration happens via `ambix query <orig-session-id> <ix>`, with the instruction given once in the preamble rather than repeated per field.

**Distinct from both CC's internal tool_use shape AND the harness's display-trimming pattern.** CC's tool_use JSON is `{"type":"tool_use","name":"Edit","input":{…}}`; our XML is `<tool_use name="Edit" ix="N">…</tool_use>` with per-tool children. CC's harness trims overly-long displayed tool_use values to `<truncated>preview…</truncated>[COMPACTION STUB — ... ambix query <sid> <ix>]` — our truncation attribute on per-field elements is a visually and structurally different shape. Both differences are intentional: they prevent the resumed agent from pattern-matching compacted summaries back into new tool calls. See `_experimental/structural/DEPRECATED.md` for the failure mode that drove this design.

**Chain + sessionId.** The emitted file lives at `~/.claude/projects/<source-slug>/<new-uuid>.jsonl`. `parentUuid` is rebuilt as a linear chain through every emitted entry; `sessionId`, `promptId`, `requestId`, and `message.id` are all regenerated fresh — leaving any source-session routing IDs in place makes CC treat the compacted entries as duplicates and skip them when assembling resume context.

**Tasks sidecar snapshot.** CC keys per-session task state by session UUID (`~/.claude/tasks/<sessionId>/`). A fresh UUID by itself has no matching tasks dir, so `TaskCreate`/`TaskUpdate` reminders from the source would be lost. `ambix compact` deep-copies the source's tasks dir to the new session's, so the compacted session inherits the task state at compaction time. The two sessions are independent from that point on: subsequent task mutations on one side don't leak to the other, which matters if the source is later forked or continued.

**User preserve selectors.** `--preserve <kind>:<pattern>` exempts matching content from condensation. `tool:<glob>` keeps the tool_use input fields + real tool_result body inside the bundled `<turns>` block (useful when a tool IS the user-visible channel — e.g., an MCP Telegram plugin whose tool_use *is* the outgoing message); `type:<glob>` promotes matching entries to real JSONL pass-through (like `type:file-history-snapshot` if you want CC rewind-with-code to work through the condensed range). Repeatable; glob is `*`/`?`/literal with case-sensitive whole-name matching. Active selectors are listed in the bundled message's preamble so the resumed agent knows preserved content isn't a stub.

**Why this over `/compact`:** a resuming agent reads a structured summary with explicit rehydration commands — it can reason about turn boundaries via the `<tool_use>`/`<tool_result>` structure and reach for `ambix query` to pull the exact historical content of any condensed turn. Validated end-to-end against CC 2.1.112 — see `docs/specs/2026-04-17-compact-to-session.md`.

## Narrative schema

The `Narrative` is the agent-produced core of the artifact. Each field carries a `refs` array of turn indices pointing back into the source session.

### Fields

**summary** -- 1-3 sentence overview of what the session accomplished.

**main_tasks** -- what the session was trying to accomplish. Each has a `status`:
- `completed` -- task finished successfully
- `partial` -- task started but not fully done
- `abandoned` -- task was dropped or replaced
- `verified` -- task finished and confirmed working (tests pass, feature works)

**episodes** -- discrete segments of work. Each has a `kind`:
- `research` -- reading code, exploring the codebase, gathering information
- `planning` -- designing an approach, discussing strategy
- `implementation` -- writing code, making changes
- `debugging` -- investigating and fixing failures
- `review` -- reviewing changes, running tests
- `housekeeping` -- formatting, cleanup, config changes
- `other` -- doesn't fit the above

Episodes have an `ix_range` (`[start, end]`) marking the turn range they cover.

**decisions** -- choices made during the session and why. Each has a `description` and `rationale`.

**corrections** -- places the agent backtracked or the user corrected course. Each has a `kind`:
- `self_correction` -- the agent caught its own mistake
- `user_correction` -- the user pointed out an issue
- `subagent_error` -- a spawned subagent made an error

**verification** -- whether and how the work was confirmed to work. Has `was_verified` (boolean) and `how` (free text).

**friction_points** -- places the agent struggled. Optional `attribution` suggests the likely source (e.g., "unclear requirements", "flaky test").

**wins** -- things that went well.

**unresolved** -- open threads at session end.

## Subagent handling

Claude Code can spawn subagent tasks. In the source session log, the parent contains only a `Task` tool_use (with the prompt) and its tool_result (the subagent's final message). The subagent's internal work -- all its tool calls, reads, edits -- is logged to a separate session file.

During staging, each subagent session gets a condensed `session.jsonl` and optional `turns/` directory under `subagents/<agent-id>/`. Spill files from subagent tools land in the parent session's shared `spill/` directory. The distiller agent reads subagent sessions when the parent's Task tool_result doesn't tell the full story of what the subagent did.

## Running the full pipeline

`run()` wires the four stages together with tmp workspace management, retry handling, distiller log capture, and token accounting. It:

1. Resolves the session path (file path or UUID lookup)
2. Creates a tmp workspace
3. Stages the session
4. Runs deterministic analysis
5. Runs the distiller agent (with lint-gate retries)
6. Merges metadata + analysis + narrative into the artifact
7. Persists to disk
8. Captures the distiller's own session log for debugging
9. Computes authoritative token usage from the captured log

See `RunOptions` and `RunResult` types for the full set of options and return values.

## Agent tools

During a distill run, the distiller agent is given access to ambix subcommands as callable tools via wrapper scripts in `bin/`:

- `bin/query <session.jsonl> <subcmd>` -- search the source session for messages, tool uses, etc.
- `bin/file-at <path> <ix>` -- fetch a file version at a given turn
- `bin/lint-output` -- validate narrative.json against the schema before declaring done

These are the same subcommands available at the CLI level. See the [CLI reference](cli.md) for full flag documentation.
