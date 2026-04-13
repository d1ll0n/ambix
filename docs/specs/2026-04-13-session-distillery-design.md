# Session Distillery — Design

**Date:** 2026-04-13
**Status:** Design accepted, implementation pending
**Related repos:** `alembic` (this repo), `parse-claude-logs` (sibling, pure library dependency)

---

## Purpose

Produce per-session summary artifacts that feed into deeper review agents which analyze the user's Claude Code harness, documentation, agent memory, CLAUDE.md files, skills, and tools, and make recommendations for improvement. Think of it as a much more in-depth version of Claude Code's `/insights` command.

A secondary goal: the same artifacts support day-journal rollups across sessions, giving the user a higher-level view of what got done and how CC was used.

## Goals

1. **Every session produces one structured JSON artifact** capturing what happened, what was decided, what went well or poorly, and where the friction was.
2. **Traceability is preserved.** Every narrative claim in the artifact carries references to the source turns where the thing happened, so downstream review agents can cite back into the log without re-reading the entire session.
3. **Deterministic vs. reasoning work is cleanly separated.** Anything derivable from the session log structurally is computed deterministically; anything requiring reasoning is produced by a distiller agent.
4. **The distiller agent sees a context-efficient view** of the session — a condensed linear log with rehydration pointers — and can pull full detail only when needed.
5. **The artifact format is cheap to ingest** into a future storage system (flat JSON, stable schema, no hidden filesystem coupling).

## Non-goals (for v1)

- Cross-session analysis or review. This design produces per-session artifacts; the review pass is a downstream project that consumes them.
- Real-time distillation during a live session. Distillation runs on completed (or paused) sessions.
- UI. The artifact is JSON; any human-facing rendering is a later, separate concern.
- Storing sessions in a database. The v1 output is flat files on disk; a DB backend can be added later without schema changes.

---

## Architecture: strict library / orchestrator split

The system spans two repositories, with a strict boundary: all new code lives in `alembic`. `parse-claude-logs` is used unchanged as a pure library dependency.

### `parse-claude-logs` (sibling repo, open-source library)

Used as a pure library dependency — **gains no new code** for this project. alembic imports:

- `Session` class (entry parsing, scalar metadata, lazy caches)
- `src/derive/*` modules for direct session facts (metrics, compaction, tool-calls, first-message, ongoing, skills, deferred-tools)
- `src/discover.ts` (project and session discovery)
- `src/subagents.ts` (subagent file location, new + legacy layouts)
- `src/persisted-output.ts` (spill file parsing and dereferencing)
- `src/file-history.ts` (file-history blob joining)
- Typed entries: `LogEntry`, `ContentBlock`, `AttachmentPayload`, `ToolUseResultData`

Rationale: parse-claude-logs is a general-purpose library for parsing, exploring, and searching Claude Code session logs. Analysis-for-distillation is a specific workflow built on top of that library, not part of its core responsibility. Binding parse-claude-logs' API to alembic's specific needs would constrain its evolution and conflate layers. Keeping the boundary strict preserves both repos' focus: parse-claude-logs stays minimal and reusable; alembic is free to evolve its agent harness, storage strategy, and DB migration without churn in the public library.

If a primitive currently in alembic ever turns out to be reusable outside distillation (e.g. someone wants bash pattern clustering for a different tool), we can extract it into parse-claude-logs then. Reversing a premature extraction is cheap, reversing a premature coupling is expensive.

### `alembic` (this repo, private)

Owns the full pipeline end-to-end:

- Depends on `parse-claude-logs` as a library (via `file:../parse-claude-logs`).
- **Deterministic analysis passes** (`src/analyze/`) — tool-use aggregates, per-file churn timelines, bash pattern clustering, failure surface collection, token density timelines, subagent cross-reference, spill file inventory, permission event timeline.
- **Tmp-dir staging** (`src/stage/`) — constructs the self-contained working directory for the distiller agent: copies session + subagents + spill files + file-history blobs into the layout defined below.
- **Condensed JSONL rendering** (`src/stage/condense.ts`) — produces the agent-facing log with inline rehydration stubs.
- **`alembic file-at <path> <ix>` CLI** — resolves a tracked file's state at a specific turn using `parse-claude-logs`' `file-history` library exports.
- **Distiller agent orchestration** (`src/agent/`) — spawns the agent, manages validation retries, handles agent spawn mechanism.
- **Validation** (`src/agent/lint.ts`) — the `lint-output` script, shared between agent-side (copied into tmp env) and orchestrator-side (final gate).
- **Artifact merging and persistence** (`src/orchestrate/`) — combines metadata + deterministic + narrative into the final artifact, writes to `~/.alembic/sessions/<id>/artifact.json`.
- **Tmp lifecycle management** — retained during testing, discarded on success, retained on failure for debugging.

---

## Pipeline stages

```
1. Stage       → build tmp dir from session + subagents + spill files + file-history
2. Analyze     → run deterministic passes, produce stats bundle
3. Distill     → spawn agent in tmp dir, agent writes narrative JSON
4. Validate    → run linter on agent output, loop on failure (bounded retries)
5. Merge       → combine metadata + deterministic + narrative into final artifact
6. Persist     → write artifact to output location
7. Cleanup     → discard tmp (unless --keep-tmp or failure)
```

Each stage is a discrete function under `src/`; `src/orchestrate/run.ts` composes them.

---

## Tmp directory layout

The staging step produces a self-contained directory the distiller agent operates in:

```
<tmp>/
  metadata.json              # session id, version, cwd, branch, duration, end state, etc.
  session.jsonl              # condensed agent-facing log (see format below)
  turns/
    00042.json               # full untruncated entry at ix=42 (only for truncated turns)
  spill/
    toolu_Xabc.json          # copied from source tool-results/
    toolu_Xdef.txt
  subagents/
    agent-<uuid>/
      session.jsonl          # same condensed format, no further recursion
      turns/
        00012.json
  file-history/
    snapshots.json           # index: per-file version timeline from file-history-snapshot entries
    blobs/<hash>@v<N>        # raw blobs copied from ~/.claude/file-history/<session-id>/
  out/
    narrative.json           # agent-produced output (written during distill stage)
  bin/
    lint-output              # validator script, copied into tmp by staging
```

Properties:

- **Subagents cannot nest**, so `subagents/<id>/subagents/` never exists. Empirically verified: Claude Code enforces this, and spill files from tool calls *inside* a subagent land in the **parent session's** `tool-results/` directory, not a subagent-local one. Our layout reflects this — `spill/` is a single shared directory, and subagent `session.jsonl` files reference it via relative paths like `"ref":"../../spill/toolu_X.json"`.
- **Rehydration refs are relative filesystem paths.** The agent reads them with its native `Read` tool. No custom rehydration CLI, no opaque ref format, no learning curve for the agent.
- **`turns/`, `spill/`, `subagents/`, `file-history/` are all optional** — they're only populated if the session contains corresponding data. A session with no spill files has no `spill/` directory.

---

## Condensed `session.jsonl` format

One JSON object per line. Each object has:

```json
{
  "ix": 42,
  "ref": "uuid:abc-123",
  "parent_ix": 41,
  "role": "assistant",
  "ts": "2026-04-12T14:33:12Z",
  "tokens": { "in": 1200, "out": 340, "cache_read": 8000 },
  "content": [
    { "type": "text", "text": "..." },
    {
      "type": "tool_use",
      "name": "Edit",
      "id": "toolu_X",
      "input": { "file_path": "...", "old_string": "...", "new_string": "..." }
    }
  ]
}
```

Key properties:

- **`ix`** is the session-local numeric index. Every reference in the final artifact and every file under `turns/` uses `ix`, not UUIDs. A post-processing pass can resolve these to UUIDs via the `ref` field if needed.
- **`content` mirrors the source entry shape**, so tool_use / tool_result / thinking / attachment blocks appear in their natural form. No translation layer that could lose information.
- **Duplicate streaming entries are removed** via `deduplicateByRequestId` (existing in parse-claude-logs).
- **`<synthetic>` model entries are preserved** in the condensed log (the agent should see them), but are flagged via a top-level `synthetic: true` field so the agent can easily distinguish harness-generated turns.

### Truncation and rehydration stubs

Large payloads are replaced inline with a rehydration stub. The agent sees these during a linear read and can decide whether to fetch the full version based on `tokens_est`.

**Spill file reference** (already off-log in source):
```json
{
  "type": "tool_result",
  "tool_use_id": "toolu_X",
  "result": {
    "truncated": true,
    "ref": "spill/toolu_X.json",
    "bytes": 51300,
    "tokens_est": 12800,
    "preview": "first ~500 chars of the original content"
  }
}
```

**Large inline content truncation** (e.g. a big Edit `old_string` or a Read tool_result):
```json
{
  "type": "tool_use",
  "name": "Edit",
  "id": "toolu_Y",
  "input": {
    "file_path": "src/big-file.ts",
    "_truncated": true,
    "_ref": "turns/00042.json",
    "_bytes": 18400,
    "_tokens_est": 4600,
    "_preview": "first few lines of old_string..."
  }
}
```

**Subagent invocation**:
```json
{
  "type": "subagent_call",
  "agent_id": "abc-uuid",
  "ref": "subagents/agent-abc-uuid/session.jsonl",
  "turn_count": 47,
  "tokens_est": 38200
}
```

Thresholds for "large":
- Spill files are always truncated (they're off-log by definition).
- Inline tool_use inputs / tool_result content are truncated when they exceed **~2KB** or **~500 tokens est**. Tunable.
- Subagent calls are always represented as a single truncation stub in the parent's condensed log — never inlined.

### Preview generation

Previews are deterministic: first N characters of the text content, or for structured tool inputs, the first N characters of a stable JSON render. No semantic summarization in the preview — the agent doesn't need to guess which of our paraphrases to trust.

---

## Deterministic layer

### Sourced from `parse-claude-logs`

alembic imports these library exports and composes them into its analysis output — it does not reimplement them:

- Session metadata (`first-observed.ts`)
- Token metrics per model, message counts (`metrics.ts`)
- Compaction phases (`compaction.ts`)
- Subagent discovery (`subagents.ts`)
- Tool call / result flat extractors (`tool-calls.ts`)
- Skill and deferred-tools aggregates
- First user message (`first-message.ts`)
- Ongoing-state detection (`ongoing.ts`)
- Spill file parsing (`persisted-output.ts`)
- File-history blob joining (`file-history.ts`)

### New passes (in `alembic/src/analyze/`)

1. **Tool-use aggregates** — invocations per tool, per-file Edit/Write/Read counts, unique files touched, **read-without-write files** (files the agent read one or more times but never modified — a candidate signal for "rediscovery").
2. **Bash pattern clustering** — normalize Bash commands by first token + flag shape, cluster repeated invocations. Surfaces "this complex one-liner was used 8 times; candidate for a script."
3. **File churn timeline** — ordered per-file event list (read → edit → read → edit) across the session. Drives both agent reasoning and day-journal rollups.
4. **Failure surface** — every `is_error: true` tool_result with the corresponding tool_use input preserved in full (no truncation unless massive). Goes into the final artifact only, not the agent briefing.
5. **Token density timeline** — ordered `[ix, tokens_total]` series, so downstream visualization can see where expensive turns were without summing manually.
6. **Subagent cross-reference** — which tool_use_id in the parent log launched which subagent session, with reverse links.
7. **Spill file inventory** — every `<persisted-output>` reference with target path, byte size, tool_use_id, owning turn.
8. **Permission / hook event timeline** — hook_additional_context, permission-mode changes, command_permissions, all timestamped.

### Two audiences for deterministic output

The deterministic pass serves two audiences with different needs:

| Audience | Contents | Why |
|---|---|---|
| **Agent briefing** (shipped into `metadata.json`) | Session metadata only: id, version, cwd, branch, duration, end state, permission mode | Minimal, structural, non-biasing. Anything that duplicates what the agent will read in the log, or that requires reasoning to produce, is excluded. |
| **Final artifact** (shipped into `artifact.json.deterministic`) | Everything above plus full deterministic pass output | Downstream review agents consume the full deterministic view alongside the distiller's narrative. |

Why this split: partial or noisy heuristic signals in the agent briefing can anchor the agent's attention and make it defer to our pre-computed judgment instead of its own read. Specifically excluded from the agent briefing:

- Correction-pattern grep (requires reasoning)
- Idle-gap episode hints (requires reasoning)
- Failure summaries (agent sees failures inline in the log)
- Top-level tool-use stats (agent sees tool calls inline in the log)

The agent discovers all of these by reading the condensed log. Only structural metadata is pre-computed for it.

---

## Agent environment

### System prompt shape

- **Role**: session distiller
- **Goal**: produce a structured JSON narrative at `out/narrative.json` following the defined schema
- **Inputs**:
  - `metadata.json` — small, read first
  - `session.jsonl` — primary source, read linearly
  - `turns/`, `spill/`, `subagents/`, `file-history/` — on-demand rehydration via native `Read` tool
  - `alembic file-at <path> <ix>` — the one CLI for reading a tracked file's state at a specific turn
- **Rehydration guidance**: when a truncation stub's `tokens_est` is comparable to or smaller than what the agent expects to gain from reading it, rehydrate. When it's dramatically larger and the surrounding context doesn't suggest importance, skip.
- **Schema reminder**: inline summary of the narrative schema, with a note that `out/narrative.json` must pass `lint-output` before the agent stops.
- **Verification requirement**: agent must run `lint-output` before declaring done.

### Filesystem-as-interface

The agent uses native Claude Code tools (`Read`, `Glob`, `Grep`, `Bash`) for everything. No custom CLI to learn, aside from the single `file-at` primitive. The filesystem layout IS the interface.

### One CLI tool: `alembic file-at <path> <ix>`

The only case where filesystem-as-interface breaks down is "what did file X look like at turn Y." Pre-materializing per-turn file snapshots would duplicate large amounts of data; a small CLI tool resolves on demand instead.

- Run from within the staged tmp directory (default) or with an explicit `--tmp <path>`
- Walks `file-history/snapshots.json`
- Finds the blob that was current for `path` at turn `ix`
- Prints raw content to stdout, exits non-zero if not found

Lives in `alembic`. Uses `parse-claude-logs`' file-history library exports internally.

---

## Validation

Two independent checks catch different failure modes:

1. **`lint-output` script in the tmp env** (`bin/lint-output`, copied in by staging). The agent is required to run it via Bash before finalizing `out/narrative.json`. Checks:
   - JSON schema (structure, required fields, enum values for `status`, `kind`, etc.)
   - Every `refs` value is a valid `ix` in `session.jsonl`
   - Every `ix_range` in episodes is valid and non-inverted
   - Subagent refs (if used) resolve to existing `subagents/<id>/session.jsonl`
   - Output file exists at the expected path

2. **Orchestrator re-runs the same linter as a final gate.** If lint passed before the agent's last edit but then drifted, or if the agent skipped the step, the gate catches it.

3. **On gate failure**, orchestrator sends a follow-up message to the agent with the lint errors. Budget: 2 retries. After that, fail loudly — a session that can't be distilled is itself a data point for the review pass.

The linter is a small TypeScript/node script. One implementation (`src/agent/lint.ts`), used in two places: directly by the orchestrator at the final gate, and copied into each tmp env as `bin/lint-output` for agent-side use. Same code both places, zero drift.

---

## Output artifact schema

Single JSON file per session. Flat structure, stable shape, cheap to ingest into any downstream store.

```json
{
  "schema_version": "1",
  "session_id": "uuid",
  "generated_at": "2026-04-13T00:00:00Z",

  "metadata": {
    "version": "2.1.97",
    "cwd": "/home/user/...",
    "git_branch": "master",
    "permission_mode": "...",
    "start_ts": "...",
    "end_ts": "...",
    "duration_s": 4821,
    "turn_count": 312,
    "end_state": "completed"
  },

  "deterministic": {
    "tokens": { "by_model": { "...": { "in": 0, "out": 0, "cache_read": 0, "cache_write": 0 } }, "totals": { "in": 0, "out": 0 } },
    "tools": { "invocations": { "Edit": 47, "Read": 89, "Bash": 32 }, "per_tool_calls": [ ] },
    "files": {
      "touched": [ { "path": "...", "reads": 3, "edits": 2, "writes": 0 } ],
      "read_without_write": [ "src/config.ts" ],
      "churn_timeline": [ { "path": "...", "events": [ { "ix": 12, "kind": "read" } ] } ]
    },
    "bash_clusters": [ { "pattern": "git log --oneline -n {N}", "count": 6, "examples_ix": [ 12, 34, 55 ] } ],
    "failures": [ { "ix": 87, "tool": "Edit", "input": { }, "error": "..." } ],
    "compaction_phases": [ { "start_ix": 0, "end_ix": 120, "baseline_tokens": 14200 } ],
    "subagents": [ { "agent_id": "...", "parent_ix": 45, "tokens": 3800, "duration_s": 120, "tools": { } } ],
    "spill_files": [ { "tool_use_id": "toolu_X", "bytes": 51300, "owning_ix": 67 } ],
    "token_density_timeline": [ [0, 1200], [1, 340] ],
    "permission_events": [ { "ix": 23, "kind": "permission_mode_change", "from": "...", "to": "..." } ]
  },

  "narrative": {
    "summary": "1-3 sentences, top-level gist of the session",

    "main_tasks": [
      {
        "title": "Rewrite parser into general-purpose library",
        "status": "completed",
        "description": "...",
        "refs": [12, 47, 89]
      }
    ],

    "episodes": [
      {
        "title": "Initial exploration of current parser",
        "kind": "research",
        "ix_range": [0, 23],
        "summary": "Agent mapped existing derive modules and types before proposing changes.",
        "refs": [5, 18]
      }
    ],

    "decisions": [
      {
        "description": "Keep Session class getters synchronous; throw before first await.",
        "rationale": "A silent null would propagate through downstream code.",
        "refs": [34]
      }
    ],

    "corrections": [
      {
        "description": "Sonnet subagent got the isOngoing logic wrong on first pass; parent caught and redirected.",
        "kind": "subagent_error",
        "refs": [52, 55]
      }
    ],

    "verification": {
      "was_verified": true,
      "how": "Ran `npm test` showing 104 passing and `npx tsc --noEmit` clean.",
      "refs": [91]
    },

    "friction_points": [
      {
        "description": "Spent 6 turns rediscovering that Session scalar getters throw before await.",
        "refs": [34, 41, 52],
        "attribution": "Could live as a user-memory entry — currently only in the handoff doc."
      },
      {
        "description": "Sonnet subagent re-read 4 files the parent already had in context.",
        "refs": [78, 91],
        "attribution": "Parent prompt didn't include file contents it already had."
      }
    ],

    "wins": [
      {
        "description": "Parallel doc generation via haiku subagents completed Wave 2 faster than sequential would have.",
        "refs": [102, 115]
      }
    ],

    "unresolved": [
      { "description": "CI hook for `types:check` not wired in yet.", "refs": [140] }
    ]
  }
}
```

### Schema notes

- **Every narrative item carries `refs`** — session-local `ix` values. Unreferenced narrative is useless for downstream review.
- **`friction_points` absorbs "review hints"**. Each friction point can optionally carry an `attribution` field when the agent has a concrete suggestion about the source. Free-form prose — no constrained taxonomy. Downstream review agents can cluster friction points without our categories biasing them.
- **`episodes` and `main_tasks` are separate** — one task can span multiple episodes, and housekeeping episodes may not belong to any task.
- **Status values** for `main_tasks[].status`: `completed | partial | abandoned | verified`. Enum validated by `lint-output`.
- **Episode kinds**: `research | planning | implementation | debugging | review | housekeeping | other`. Enum validated.
- **Correction kinds**: `self_correction | user_correction | subagent_error`. Enum validated.
- **`refs` values must be valid `ix` in `session.jsonl`**. Validated by `lint-output`.
- **`ix_range` values must be `[start, end]` with `start <= end` and both valid**. Validated by `lint-output`.

---

## Orchestration and lifecycle

### Entrypoint

```
alembic distill <session-id> [--output <path>] [--keep-tmp] [--tmp-root <path>]
```

- `<session-id>` can be a UUID (resolved via `parse-claude-logs` discovery), an absolute path to a `.jsonl`, or a path relative to `cwd`.
- `--output` defaults to `~/.alembic/sessions/<session-id>/artifact.json`.
- `--keep-tmp` retains the staging directory after success. Default is to clean up on success, retain on failure.
- `--tmp-root` overrides the staging root (default `$TMPDIR/alembic/<session-id>-<rand>`).

### Lifecycle

1. **Resolve session** — locate the real `.jsonl` via parse-claude-logs discovery.
2. **Stage** — build the tmp directory from the resolved session. Copy spill files, subagent files, file-history blobs. Produce `metadata.json` and `session.jsonl`. Write per-turn full-detail files under `turns/`. Copy `lint-output` script into `bin/`.
3. **Analyze** — run deterministic passes, hold results in memory (not yet written).
4. **Distill** — spawn agent with tmp dir as cwd and system prompt briefing it on inputs and schema. Agent writes `out/narrative.json`.
5. **Validate** — run `lint-output` on the agent's output. On failure, send errors back to agent, retry up to 2 times.
6. **Merge** — combine `metadata` (from deterministic) + full deterministic payload + agent narrative into the final artifact object.
7. **Persist** — write artifact JSON to output location. Create parent directories as needed.
8. **Cleanup** — discard tmp dir on success unless `--keep-tmp`. Retain on failure regardless, and log the tmp path for debugging.

### Agent spawn mechanism

The initial implementation uses the Agent SDK to dispatch the distiller. This is an implementation detail subject to change — the orchestrator treats the distiller as a black box that produces `out/narrative.json` given a tmp dir. Future versions may swap to Claude Code subagent dispatch, a managed agent, or a long-running daemon.

The distiller agent is **not** a Claude Code sub-agent of the current session. It runs out-of-band, typically after the session it's analyzing has ended.

### Cost and model selection

TBD during implementation. Rough heuristic: sonnet for most sessions, opus for sessions with complex multi-phase work or many subagents, haiku avoided (the docs-phase experience showed haiku struggles with complex logic reasoning).

---

## Durable output layout

```
~/.alembic/
  sessions/
    <session-id>/
      artifact.json          # the final merged artifact
      tmp/                   # only if --keep-tmp or failure
        session.jsonl
        turns/
        spill/
        subagents/
        file-history/
        out/
          narrative.json
          lint.log
        bin/
          lint-output
  logs/
    <date>/<session-id>.log  # orchestrator run log (for debugging)
```

Flat `sessions/<id>/` structure supports day-journal rollups via `glob` and supports DB migration later (one artifact = one row).

---

## Open follow-ups

1. **Day-journal rollup pass** — a separate pipeline that reads N session artifacts from a date range and produces a higher-level summary. Not part of v1; artifact schema is designed to support it.
2. **Database storage** — v1 writes flat JSON. A future version may add an ingester that loads artifacts into SQLite or Postgres. Schema is designed to be ingestible without changes.
3. **Cross-session deduplication of friction points** — if the same friction appears across many sessions, it's a stronger signal. Handled at review-pass time, not distillation time.
4. **Preview generation tuning** — first N chars is a reasonable default but we may want smarter previews for specific tool types (e.g. first line + last line of a big diff).
5. **Attribution field quality** — the `friction_points[].attribution` is free-form, which risks inconsistency. Acceptable for v1; the review pass can cluster.
6. **Agent spawn mechanism selection** — picking between Agent SDK / Claude Code subagent dispatch / managed agent. Decided during alembic implementation.
7. **Model selection strategy** — per-session model choice based on complexity signals. Deferred to an optimization pass.
8. **Possible future extraction** — if a primitive currently in alembic (bash pattern clustering, file churn timeline, etc.) turns out to be reusable outside distillation, extract it into `parse-claude-logs` then. Don't pre-extract.

---

## Summary of decisions

| Decision | Choice |
|---|---|
| Architectural scope | Strict split: parse-claude-logs unchanged pure library dep; all new code in alembic |
| Agent-facing log format | JSONL with inline rehydration stubs |
| Rehydration mechanism | Filesystem-as-interface (relative paths, native Read tool) |
| Special CLI | One tool: `alembic file-at <path> <ix>` |
| Episode detection | Agent's job (no deterministic hints to avoid biasing) |
| Correction/mistake detection | Agent's job |
| Deterministic audience split | Agent briefing = metadata only; final artifact = full deterministic view |
| Output artifact | Single flat JSON with `{metadata, deterministic, narrative}` |
| Reference format | Session-local `ix` values throughout narrative |
| Review-hint taxonomy | None — free-form `attribution` field on friction points |
| Validation | `lint-output` script run by agent AND orchestrator |
| Tmp lifecycle | Cleaned on success, retained on failure, `--keep-tmp` flag available |
| Output location | `~/.alembic/sessions/<session-id>/artifact.json`, flat |
