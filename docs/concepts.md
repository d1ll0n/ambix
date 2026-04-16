# Concepts

This document walks through the ambix pipeline in detail and describes the shape of the final artifact. For the high-level overview, see the [README](../README.md).

## Pipeline

Ambix processes a Claude Code session JSONL file through four stages:

```
session.jsonl
    │
    ▼
┌─────────┐     ┌──────────┐     ┌────────────┐     ┌─────────────┐
│  Stage  │ ──▶ │ Analyze  │ ──▶ │  Distill   │ ──▶ │ Merge +     │
│         │     │          │     │  (agent)   │     │ Persist     │
└─────────┘     └──────────┘     └────────────┘     └─────────────┘
    │               │                  │                   │
    ▼               ▼                  ▼                   ▼
  tmp dir       AnalyzeResult     narrative.json      ~/.ambix/
```

### 1. Stage

`stage()` copies a session into a tmp workspace and produces a format the distiller agent can cheaply read. Given a `Session` and a `tmpDir`, it writes:

- `condensed.jsonl` — the session's turns with large tool results inlined up to a size threshold and replaced with rehydration stubs beyond it.
- `full-turns/NNNNN.json` — full JSON for any turn whose content was truncated in `condensed.jsonl`.
- `tool-results/<id>.json` — rehydrated large tool results keyed by tool-use ID.
- `file-history/snapshots.json` + blob files — a snapshot index and per-version content blobs for every file the session edited.
- `subagents/<agent-id>/…` — the same staging structure nested for every subagent spawned in the session.
- `metadata.json` — session metadata (id, slug, cwd, timestamps).

This layout is described by the `StageLayout` type.

### 2. Analyze

`analyze()` takes a `Session` and performs a deterministic pass that produces an `AnalyzeResult` containing:

- **tokens** — per-model and aggregate token totals (`in`, `out`, `cache_read`, `cache_write`) plus a timeline of token density by turn.
- **tools** — per-tool use counts and failure counts.
- **files** — tracked file records (version counts, churn timeline).
- **bashClusters** — clusters of related bash invocations.
- **failures** — tool-call failure records.
- **subagents** — records for every subagent spawned.
- **spills** — `SpillRecord` entries for large tool outputs stored on disk.
- **permissionEvents** — permission mode transitions and grants.

Analyze never calls the model — it's pure data reduction over the parsed session.

### 3. Distill

`distill()` invokes an `AgentRunner` (either `RealAgentRunner` or `MockAgentRunner`) against the staged tmp directory. The agent's system prompt (see `buildSystemPrompt`) includes a tree view of the staged directory and instructions to produce a structured `Narrative` JSON document at `out/narrative.json`.

The runner's output is then lint-gated: `lintNarrative` validates the JSON against the `Narrative` schema. If lint fails, distill retries up to `maxRetries` times (default 2) with the lint errors fed back to the agent.

The `Narrative` shape includes:

- `mainTask` — what the session was trying to accomplish
- `episodes[]` — discrete segments of work (research, planning, implementation, debugging, verification, …)
- `decisions[]` — choices made and their rationale
- `corrections[]` — places the agent backtracked or the user corrected course
- `verifications[]` — how things were confirmed to work
- `frictionPoints[]` — places the agent struggled
- `wins[]` — things that went well
- `unresolved[]` — open threads at session end

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

`persistArtifact()` writes the artifact to `~/.ambix/<session-id>/artifact.json` by default (override via `outputRoot`).

## Running the full pipeline

`run()` wires these four stages together with tmp workspace management, retry handling, distiller log capture, and authoritative token accounting. See `RunOptions` and `RunResult` in the API reference.

## Agent tools

During a distill run, the distiller agent is given access to ambix subcommands as callable tools:

- `ambix file-at <path> <ix> --tmp <staged-dir>` — fetch a file version at a given turn
- `ambix query <session> <subcmd>` — search the source session for messages, tool uses, etc.

These are CLI subcommands that also exist for human debugging but are primarily shaped for agent consumption. Their output is machine-readable and their flags are documented via `<subcommand> --help`.
