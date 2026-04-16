# ambix

**Session distillation pipeline for [Claude Code](https://claude.ai/code) session logs.**

Ambix stages, analyzes, and distills Claude Code session JSONL logs into structured summary artifacts suitable for downstream review, search, and retrospective analysis.

> **Status:** Experimental. API may change before v1.0.

## Requirements

- Node.js >= 22

## Installation

> **Note:** Ambix currently depends on `parse-cc` as a sibling checkout. A published npm release is pending.

```bash
npm install ambix
```

## CLI Quickstart

Distill a session into a structured artifact:

```bash
ambix distill /path/to/session.jsonl
```

This runs the full pipeline (stage → analyze → distill → merge) and writes an artifact to `~/.ambix/<session-id>/`. Use `--mock` to run with a placeholder runner that skips the API call.

Other subcommands:

- `ambix analyze <session>` — deterministic analysis only (JSON to stdout)
- `ambix stage <session>` — stage a session into a tmp workspace
- `ambix file-at <path> <ix>` — print a tracked file's content at a given turn
- `ambix query <session> <subcmd>` — search within a session log

Run `ambix help` or `ambix <subcommand> --help` for full flag documentation.

> The `stage`, `file-at`, and `query` subcommands are primarily intended as tools the staged distiller agent calls during a distill run. `distill` and `analyze` are the human-facing entry points.

## Concepts

Ambix runs a four-stage pipeline over a Claude Code session log:

1. **Stage** — copies the session into a tmp workspace and produces a condensed JSONL view with rehydrated file histories and tool result snapshots.
2. **Analyze** — deterministic pass that computes token totals, tool usage, file churn, bash clusters, failures, and permission events.
3. **Distill** — an agent reads the staged workspace and produces a structured `Narrative` (main task, episodes, decisions, corrections, verifications, friction points, wins, unresolved items).
4. **Merge + Persist** — combines metadata, deterministic analysis, and narrative into a final `Artifact` persisted to `~/.ambix`.

See [`docs/concepts.md`](docs/concepts.md) for the full pipeline walkthrough and artifact schema.

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

## License

MIT — see [LICENSE](LICENSE).
