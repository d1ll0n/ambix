# alembic

Session distillation pipeline for Claude Code session logs. Produces per-session structured summary artifacts that feed into downstream review agents analyzing agent harnesses, documentation, memory, skills, and tools.

## Status

Scaffold only. Implementation pending.

## Design

Full design spec: [`docs/local-plans/specs/2026-04-13-session-distillery-design.md`](docs/local-plans/specs/2026-04-13-session-distillery-design.md)

## Architecture

- **`parse-claude-logs`** (sibling repo at `../parse-claude-logs`) — used as a pure library dependency. Provides Session parsing, discovery, derive modules, spill file handling, subagent discovery, and file-history joining. Open-source-ready.
- **`alembic`** (this repo) — owns the full distillation pipeline: deterministic analysis, tmp-dir staging, condensed JSONL rendering, distiller agent orchestration, output validation, artifact merging, and storage. All new code for this project lives here.

## Usage (planned)

```
alembic distill <session-id>
```

Produces a single JSON artifact at `~/.alembic/sessions/<session-id>/artifact.json` containing session metadata, full deterministic stats, and an agent-produced structured narrative with traceability back to source turns.
