# alembic

Session distillation pipeline for Claude Code session logs. Produces per-session structured summary artifacts that feed into downstream review agents analyzing agent harnesses, documentation, memory, skills, and tools.

## Status

Scaffold only. Implementation pending.

## Design

Full design spec lives in the sibling `parse-claude-logs` repo:
`../parse-claude-logs/docs/local-plans/specs/2026-04-13-session-distillery-design.md`

## Architecture

- **`parse-claude-logs`** (sibling repo) provides log parsing, the condensed JSONL format, the tmp-directory staging primitives, and the `file-at` CLI tool. Open-source-ready.
- **`alembic`** (this repo) provides orchestration: deterministic analysis aggregation, distiller agent spawning, output validation, artifact merging, and storage.

## Usage (planned)

```
alembic distill <session-id>
```

Produces a single JSON artifact at `~/.alembic/sessions/<session-id>/artifact.json` containing session metadata, full deterministic stats, and an agent-produced structured narrative with traceability back to source turns.
