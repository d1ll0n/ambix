# ambix

**Session distillation pipeline for [Claude Code](https://claude.ai/code) session logs.**

Ambix stages, analyzes, and distills Claude Code session JSONL logs into structured summary artifacts suitable for downstream review, search, and retrospective analysis.

> **Status:** Experimental. API may change before v1.0.

## Requirements

- Node.js >= 22

## Installation

```bash
npm install ambix
```

Ambix uses [parse-cc](https://github.com/d1ll0n/parse-cc) for session log parsing.

## CLI Quickstart

Distill a session into a structured artifact:

```bash
ambix distill /path/to/session.jsonl
```

This runs the full pipeline (stage, analyze, distill, merge) and writes an artifact to `~/.ambix/sessions/<session-id>/`. Use `--mock` to run with a placeholder runner that skips the API call.

Produce a chronological brief for context recovery:

```bash
ambix brief /path/to/session.jsonl
```

This outputs a per-round XML summary where every tool call and assistant response is tagged with a rehydration index, so an agent can pull full details on demand via `ambix query`.

### Subcommands

| Command | Description |
|---------|-------------|
| `ambix distill <session>` | Full pipeline: stage, analyze, distill, merge, persist |
| `ambix analyze <session>` | Deterministic analysis only (JSON to stdout) |
| `ambix brief <session>` | Chronological per-round summary for context recovery |
| `ambix stage <session>` | Stage a session into a tmp workspace |
| `ambix file-at <path> <ix>` | Print a tracked file's content at a given turn index |
| `ambix query <session> <sub>` | Search within a session log (tool-uses, tool-results, text-search, show) |

Run `ambix <subcommand> --help` for full flag documentation. See [`docs/cli.md`](docs/cli.md) for the complete CLI reference.

## Concepts

Ambix runs a four-stage pipeline over a Claude Code session log:

1. **Stage** -- copies the session into a tmp workspace and produces a condensed JSONL view with rehydrated file histories and tool result snapshots.
2. **Analyze** -- deterministic pass that computes token totals, tool usage, file churn, bash clusters, failures, and permission events.
3. **Distill** -- an agent reads the staged workspace and produces a structured `Narrative` (main task, episodes, decisions, corrections, verifications, friction points, wins, unresolved items).
4. **Merge + Persist** -- combines metadata, deterministic analysis, and narrative into a final `Artifact` persisted to `~/.ambix`.

**Compact** is a standalone capability that produces a chronological per-round summary (XML or markdown) for context recovery, independent of the distillation pipeline.

See [`docs/concepts.md`](docs/concepts.md) for the full pipeline walkthrough, compact format, and artifact schema.

### Sample artifact output

The final artifact written to `~/.ambix/sessions/<session-id>/artifact.json`:

```jsonc
{
  "schema_version": "1",
  "session_id": "abc123-...",
  "generated_at": "2026-04-16T12:00:00Z",
  "metadata": {
    "session_id": "abc123-...",
    "cwd": "/home/user/project",
    "turn_count": 84,
    "duration_s": 1200,
    "end_state": "completed"
    // ...
  },
  "deterministic": {
    "tokens": {
      "totals": { "in": 450000, "out": 38000, "cache_read": 320000, "cache_write": 95000 },
      "by_model": { "claude-sonnet-4-6": { /* ... */ } }
    },
    "tools": { "invocations": { "Edit": 12, "Read": 24, "Bash": 8, "Grep": 6 } },
    "files": { "touched": [{ "path": "src/main.ts", "reads": 3, "edits": 5, "writes": 1 }] },
    "bash_clusters": [{ "pattern": "npm", "count": 4 }],
    "failures": [],
    "subagents": []
    // ...
  },
  "narrative": {
    "summary": "Implemented user authentication with JWT tokens and added login/logout endpoints.",
    "main_tasks": [
      { "title": "Add JWT auth", "status": "verified", "description": "...", "refs": [0, 84] }
    ],
    "episodes": [
      { "title": "Research auth patterns", "kind": "research", "ix_range": [0, 12], "summary": "...", "refs": [2, 8] },
      { "title": "Implement login endpoint", "kind": "implementation", "ix_range": [13, 45], "summary": "...", "refs": [15, 30] }
    ],
    "decisions": [
      { "description": "Chose JWT over session cookies", "rationale": "Stateless, works with API clients", "refs": [5] }
    ],
    "corrections": [],
    "verification": { "was_verified": true, "how": "Ran test suite, all 12 tests pass", "refs": [80] },
    "friction_points": [],
    "wins": [{ "description": "Tests passed on first run", "refs": [80] }],
    "unresolved": []
  }
}
```

## Docs

| I want to... | Doc |
|--------------|-----|
| See every CLI flag and subcommand | [CLI reference](docs/cli.md) |
| Understand the pipeline stages and artifact schema | [Concepts](docs/concepts.md) |

## Programmatic API

Full pipeline:

```typescript
import { run, RealAgentRunner } from "ambix";

const result = await run({
  session: "/path/to/session.jsonl",
  runner: new RealAgentRunner({ model: "claude-sonnet-4-6" }),
});

if (result.success) {
  console.log(`artifact: ${result.artifactPath}`);
}
```

See `RunOptions` and `RunResult` types for the full set of options and return values.

Lower-level building blocks:

```typescript
import { stage, analyze, fileAt } from "ambix";
import { Session } from "parse-cc";

const session = new Session("/path/to/session.jsonl");
const layout = await stage(session, "/tmp/ambix-work");
const results = await analyze(session);
const file = await fileAt({
  tmp: "/tmp/ambix-work",
  path: "src/foo.ts",
  ix: 42,
});
```

## Development

```bash
npm install
npm run build       # compile TypeScript
npm test            # run tests (vitest)
npm run lint        # biome check
npm run typecheck   # tsc --noEmit
```

## License

MIT -- see [LICENSE](LICENSE).
