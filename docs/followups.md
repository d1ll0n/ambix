# Followups

Running list of things deferred during implementation that should be revisited.

Items are grouped by the plan that surfaced them. Once addressed, delete the entry (or move it to a git commit message — this file is for open items only).

---

## Recurring / cross-plan

### `ContentBlock` cast ergonomics

parse-claude-logs' `ContentBlock` union (which includes `ImageBlock`) doesn't carry an index signature, so ad-hoc casts like `block as Record<string, unknown>` fail under strict TS. Worked around in two places with the double-cast `block as unknown as Record<string, unknown>`:

- `src/stage/condense.ts` (Plan 1 Task 12)
- `src/analyze/failures.ts` (Plan 2 Task 12)

**Fix:** introduce a small helper or type guard — e.g. `asRecord(block: ContentBlock): Record<string, unknown>` — and use it in both places. If the double-cast keeps showing up, consider a `getContentBlockField(block, key)` utility that handles the narrowing internally.

### parse-claude-logs built artifacts can drift

During Plan 1 Task 10, the Task 10 subagent couldn't import `defaultFileHistoryDir` from `parse-claude-logs` because the sibling repo's `dist/` was stale relative to its source (the export existed in `src/` but not in the built `dist/index.d.ts`). Rebuilding parse-claude-logs fixed it.

**Fix options:**
- A postinstall hook in alembic that runs `npm --prefix ../parse-claude-logs run build` if `dist/index.d.ts` is older than `src/`
- A README note telling future alembic work to rebuild parse-claude-logs before running tests if it has changed
- When alembic gets CI, have it build parse-claude-logs as a pre-step
- Long-term: publish parse-claude-logs to a registry (even a private one) so alembic pins a specific built version

---

## Plan 1 (staging + file-at)

### Optional sidecar linkage for Task tool_use → subagent session

Parent `Task` tool_use blocks are preserved in the condensed log (correct behavior — we keep all blocks). The distiller agent currently discovers staged subagents by globbing `subagents/*/session.jsonl` and correlating by reading. A lightweight optimization would be to emit a sibling annotation next to each `Task` block (or at entry level) with a resolved `subagents/<agent-name>/session.jsonl` reference. Not blocking — glob-based discovery is fine for v1.

### `bytes` field always null in snapshots index

`src/stage/file-history.ts` writes `bytes: null` for every file-history blob in `snapshots.json`. Filling this requires a `stat()` per blob during staging.

**Fix:** add a `stat()` in the copy loop and populate `bytes` from the result. Trivial, just not done yet.

### CLI doesn't resolve session UUIDs

`alembic stage` and `alembic file-at` both require full filesystem paths. parse-claude-logs' `findAllSessions`/`listSessions` could resolve a UUID to a path.

**Fix:** in `src/cli.ts`, if the session argument looks like a UUID (not an existing file path), resolve via discovery before constructing `new Session(path)`.

### No committed integration fixture for CLI smoke test

Plan 1's Task 12 smoke test relies on whatever real session the user has on disk. Not repeatable.

**Fix:** commit a small trimmed fixture under `tests/fixtures/integration/` (similar to parse-claude-logs' approach) and add a single vitest integration test that runs `stage` + `file-at` against it programmatically.

### user-only sessions report `end_state: "completed"`

`parse-claude-logs`' `isOngoing()` returns `false` for a session that has only user messages (no assistant turn). alembic's `buildMetadata` maps that to `end_state: "completed"`, which is probably wrong — such sessions are more plausibly unfinished. Observed in Plan 1 Task 3.

**Fix:** add an "unknown" heuristic — if the session has `< 2` entries OR the last entry is a user turn with no following assistant, report `end_state: "unknown"` instead of "completed".

---

## Plan 2 (deterministic analysis)

### Bash clustering surfaces env-var and command-substitution prefixes

First-token clustering catches things like `DEBUG=1 ls` as the cluster `DEBUG=1`, or `SE=$(ls ...)` as `SE=$(ls`. Plan 2's Task 12 smoke test saw real patterns like `SE=$(ls` and `AG=$(find` in the top clusters. These are wrong — the user almost certainly wants them bucketed under `ls` and `find`.

**Fix:** v2 normalizer in `src/analyze/bash-clusters.ts` that strips leading `VAR=<value>` env assignments AND unwraps leading `$(cmd ...)` command substitution before taking the first token. Revisit the "handles env prefixes" test in `tests/analyze/bash-clusters.test.ts` — currently it asserts the current (wrong) behavior.

### Subagent linkage is ordinal-based and fuzzy

`src/analyze/subagents.ts` matches parent `Task` tool_uses to subagent files by sorting both by ordinal (Task ix / subagent first-ts). If Task tool_uses and subagent files don't line up (one Task failed before spawning; a subagent file was rotated; ordering differs), the cross-reference mislabels.

**Fix:** add a first-prompt-matching fallback. Parent `Task` tool_use has an `input.prompt`; subagent's first user message should match or contain it. Use string equality / substring match as a tiebreaker when ordinal matching is ambiguous.

### `FileRecord.touched` and `ChurnRecord` are duplicative

`src/analyze/tool-aggregates.ts` and `src/analyze/file-churn.ts` both walk tool_use blocks and produce per-file views. The touched list can be derived from the churn timeline. Kept separate for API clarity in v1.

**Fix:** decide whether to merge. Keeping them separate is fine if downstream review agents want easy access to both; merging saves one walk.

### Failures pass records `input: null, tool: "unknown"` for unmatched tool_use_ids

`src/analyze/failures.ts` tolerates malformed logs by recording `tool: "unknown"` and `input: null` when the tool_use_id lookup misses. In real sessions this should never happen.

**Fix (maybe):** log a warning when this branch fires, so we can detect if malformed logs are common in practice. Or leave as-is since silent tolerance is fine.

### `permission_events` uses a fixed hook-kind allowlist

`src/analyze/permissions.ts` recognizes a fixed set: `hook_additional_context`, `hook_success`, `hook_system_message`, `command_permissions`. New hook types introduced by future Claude Code versions won't be captured until the allowlist is updated.

**Fix:** when a new hook type is observed (e.g. via the changelog or a real session scan), add it to `HOOK_ATTACHMENT_KINDS`. Also worth revisiting whether we should catch ALL `attachment` entries whose `.type` starts with `hook_` as a prefix rule, which would be more forward-compatible but could drag in unrelated types.

### v2 cluster refinement for Bash: first-two-tokens?

The "`git` was used 12 times" cluster understates variety. v2 could split by first-two-tokens (e.g. `git log` vs `git status`), but detecting subcommands is non-trivial (`git log` vs `git -C path log`, `npm run build` vs `npm test`).

**Fix:** decide whether the distiller agent actually wants finer granularity before doing the work. If the distiller's narrative is citing "git was used 12 times" without needing the subcommand detail, leave it.

---

## Plan 3 (orchestration + mock runner)

All Plan 3 followup items that were destined for this file were addressed in Plan 4:

- **Real Anthropic/Claude Agent SDK runner** — Completed in Plan 4. `RealAgentRunner` ships in `src/agent/runner-real.ts`, wired as the CLI default. See `docs/plan-4-smoke-test-results.md`.

---

## Plan 4 (real runner)

### `permissionMode` root-user workaround

`src/agent/runner-real.ts` currently passes `permissionMode: "acceptEdits"` to the Agent SDK. This is a workaround: the more permissive `bypassPermissions` maps to `--dangerously-skip-permissions` in the underlying Claude CLI, which refuses to run when the process is root (observed during Plan 4 Task 4's first smoke attempt — opaque exit code 1 with no stderr).

**Fix options:**
- Detect root at runtime and emit a clear error telling the user to either run as non-root or accept `acceptEdits` mode.
- Allow the caller to override `permissionMode` via `RealAgentRunnerOptions`.
- Document the tradeoff in the README once alembic gains one.

`acceptEdits` is fine for v1 because the distiller only needs Read/Glob/Grep/Bash/Write and all writes are inside the tmp dir, but the silent failure mode is a sharp edge worth fixing before alembic leaves the sandbox.
