# Spec: `ambix compact` — compacted session JSONL

**Status:** spec (pre-implementation)
**Date:** 2026-04-17
**Supersedes:** the existing `ambix compact` subcommand, which will be renamed to `ambix brief` (or removed — see §Rollout).

## Motivation

Claude Code's `/compact` produces a narrative text summary and continues the original session in place. Two problems with that:

1. It erases structural information. The summary is prose; the agent loses turn-by-turn pointers to "what was the exact Bash output at turn 47?"
2. It can't be inspected without opening the original session.

This feature produces an alternative: a **new, resumable session** whose on-disk representation preserves the structural history of the original but strips bulk tool output, leaving navigable rehydration pointers in place. The agent resuming the compacted session sees a real user/assistant/tool_use/tool_result transcript structure; for any truncated turn, it can run `ambix query <orig-session> <ix>` to retrieve the original content.

Validated via two throwaway /resume tests on 2026-04-17 (see §Validation). Claude Code's loader accepts the shape; Claude recognizes stubs as truncation markers; proactive rehydration works.

## Goal

> Given a source session, emit a new session JSONL at `~/.claude/projects/<same-slug>/<new-uuid>.jsonl` containing three sections: condensed pre-compaction turns with stubbed tool_result bodies, an `isCompactSummary` divider entry at the split point, and the last N rounds preserved verbatim. The new session is immediately usable via CC's `/resume`.

## Non-goals

- Replacing CC's native `/compact` in-place behavior. This feature is additive and spawns a new session; it does not mutate the source.
- Copying sidecar state (subagent logs, spill files, file-history blobs). Rehydration goes back to the original session's copies.
- Narrative distillation. That's `ambix distill`.
- Path rewriting for cross-project relocation. That's a separate feature (parse-cc's `relocate`, parked in backlog).

## User-facing CLI

```
ambix compact <session-path-or-id> [--full-recent N] [--output <path>] [--dry-run]
```

| Flag | Default | Behavior |
|---|---|---|
| `--full-recent N` | `10` | Preserve the last N rounds verbatim (each round = one user turn + the assistant turns + tool pairs following it, up to the next user turn). Everything before gets condensed. |
| `--output <path>` | `~/.claude/projects/<source-slug>/<new-uuid>.jsonl` | Override destination. |
| `--dry-run` | off | Print the plan (entry counts, byte savings estimate) and exit without writing. |

On success, prints the new session UUID and destination path to stdout.

## Renaming of existing `compact`

The existing `ambix compact` subcommand (markdown/XML per-round summary for agent READING) will be renamed to `ambix brief`. Semantics unchanged. See §Rollout.

Alternative: remove the existing `compact` entirely if no downstream users depend on it. Decide based on usage at rollout time.

## Output format

### File layout

```
[condensed entries — turns 0..N-k]        ← user/assistant/tool_use entries pass through;
                                             tool_result content replaced with stub strings
[isCompactSummary divider — 1 entry]      ← user entry with isCompactSummary=true,
                                             content = prose explaining the compaction
[preserved entries — turns N-k+1..N]      ← all content passed through verbatim
```

Empty condensed section (all turns within `--full-recent` window): skip emitting condensed entries, still emit divider + preserved.
Empty preserved section (`--full-recent 0`): skip divider? **Decision: still emit the divider** so the agent always has the explanatory preamble. It can be at end-of-file.

### Entry-level contract

Every emitted entry carries, at minimum:
- `uuid` — fresh per entry
- `parentUuid` — points at the previous emitted entry's new uuid; first entry has `parentUuid: null`
- `sessionId` — the new session's UUID (same on every entry)
- `timestamp` — **preserved from source** for condensed/preserved entries; divider gets `Date.now()`
- `cwd`, `gitBranch`, `version`, `userType`, `entrypoint` — copied from source
- `isSidechain: false`

Pass-through fields kept verbatim:
- `requestId`, `promptId` (globally unique; safe to reuse)
- `message.id`, `message.model`, `message.stop_reason`, `message.stop_sequence`, `message.usage` (assistant entries)
- `isMeta`, `toolUseResult` (user entries)

### Stub format (condensed section only)

For user entries containing `tool_result` blocks, replace each block's `content` field with a stub string:

```
[COMPACTION STUB — {condenser-summary}, ~{N} bytes removed.
 Retrieve via: ambix query {orig-session-id} {ix}]
```

Where `{condenser-summary}` comes from `src/compact/condensers.ts::condenseToolUse(name, input, originalResult)`. That function already handles Read/Edit/Write/Grep/Glob/Bash/Task/TodoWrite/Playwright + falls back to `condenseGeneric(name, input, result)` for unknown tools (prints `{toolName} {firstScalarKey}=val [error?]`).

Examples:
- Read: `[COMPACTION STUB — Read src/foo.ts (offset=0, limit=50) — 50 lines, ~2k tok, 2048 bytes removed. Retrieve via: ambix query <id> 47]`
- Bash: `[COMPACTION STUB — Bash "git log --oneline" — 23 lines, 1204 bytes removed. Retrieve via: ambix query <id> 51]`
- Unknown: `[COMPACTION STUB — mcp_foo__do_thing key=value, 8192 bytes removed. Retrieve via: ambix query <id> 82]`

`is_error` and `tool_use_id` on the tool_result block stay unchanged.

**Note on `ix`:** this is the SOURCE session's 0-indexed turn number, not the new session's. That's what `ambix query` takes.

### isCompactSummary divider

```json
{
  "type": "user",
  "parentUuid": "<last condensed entry uuid, or null if no condensed>",
  "uuid": "<fresh>",
  "sessionId": "<new session UUID>",
  "timestamp": "<now>",
  "isCompactSummary": true,
  "isVisibleInTranscriptOnly": true,
  "message": { "role": "user", "content": "<prose — see template below>" },
  "userType": "external",
  "entrypoint": "cli",
  "cwd": "<source cwd>",
  "gitBranch": "<source branch>",
  "version": "<source version>",
  "isSidechain": false,
  "promptId": "<fresh>"
}
```

**Content template** (may be tuned post-A/B-test):

```
This session was compacted by ambix from <orig-session-id>.

Above this divider: turns 0–<split-ix> with tool_result outputs replaced by COMPACTION STUBS.
Each stub carries an `ambix query` command that retrieves the original content.

Below this divider: turns <split-ix+1>–<last> preserved verbatim (the last <N> rounds of
the source conversation).

Do NOT infer or guess what stubbed tool_results contained — the stub text is a placeholder,
not the real output. Run the embedded command when you need the actual content.

Continue the conversation from where it left off.
```

## Destination path

Default:
```
~/.claude/projects/<slugify(source.cwd)>/<new-uuid>.jsonl
```

Same slug as the source → the compacted session appears in CC's `/resume` list alongside the source when the user is in that cwd.

## Round boundaries (for `--full-recent N`)

A "round" starts at each top-level user entry that is NOT a tool_result wrapper (`isMeta !== true`). The round extends through all subsequent assistant turns and tool_result user entries until the next top-level user turn or end-of-session. This matches `src/compact/rounds.ts`'s existing `computeRounds` logic — reuse it directly.

`--full-recent N` means: take the last N rounds in the source. Everything earlier is condensed. If source has fewer than N rounds, everything is preserved (no condensed section emitted).

## Token usage semantics

Emitted assistant entries retain their original `usage` fields (input_tokens, output_tokens, cache_*). These reflect the SOURCE session's API costs, not the new session's. `ambix info <compacted-session>` will therefore report historical numbers, which may mislead.

**Decision:** flag this in the divider content body ("Token totals reported for this session reflect the original conversation's API usage") AND consider an `ambix info` enhancement to detect `isCompactSummary` entries and annotate the output accordingly. Latter is out-of-scope for this spec; file as a follow-up.

## Edge cases

- **Source has fewer rounds than `--full-recent N`:** everything preserved; divider still emitted at the top (parentUuid: null) so the agent sees the context preamble. The condensed section is empty.
- **Source itself contains an `isCompactSummary` entry:** pass it through as a normal entry (its section is determined by whether it's in the condensed or preserved window). The NEW divider references the NEW compaction event; the old one remains as historical record.
- **Source has subagent references (Task tool_use):** condensed section's Task tool_use blocks stay structurally intact; their tool_result stubs point at `ambix query` as usual. The subagent's own session file is NOT copied — rehydration commands can handle subagent queries via `ambix query <parent-session> <ix>` which resolves internally.
- **Zero-length source:** error with a clear message; there's nothing to compact.

## Implementation shape

```
src/compact-session/
  index.ts           — public API: `compactSession(session, opts): Promise<CompactSessionResult>`
  emit.ts            — JSONL writer; parentUuid chain rebuild
  stub.ts            — stub-text builder (wraps condenseToolUse)
  summary.ts         — divider entry constructor + content template
  types.ts           — CompactSessionOptions, CompactSessionResult
src/cli.ts           — add `compact` subcommand dispatcher (rename existing → `brief`)
```

Shared helpers lifted from `src/compact/`:
- `rounds.ts::computeRounds` + `buildToolResultIndex`
- `condensers.ts::condenseToolUse`

## Validation strategy

**Unit tests** (vitest):
- Condensed tool_result content is a stub string matching the expected shape
- Preserved tool_result content passes through unchanged
- parentUuid chain is linear and consistent (first = null, each subsequent = prev.uuid)
- sessionId on every entry = new UUID
- Divider carries `isCompactSummary: true` and `isVisibleInTranscriptOnly: true`
- `--full-recent 0` = everything condensed, divider at end
- `--full-recent ∞` (larger than turn count) = everything preserved, divider at start
- Fresh UUID differs from source on every run
- Destination path defaults to same slug + new UUID

**Integration test**:
- Read a committed fixture session, compact it, write to a tmp dir, re-parse with `Session` from parse-cc, verify round-trip integrity (turn counts, model field, usage sums preserved)
- Run `ambix info` on the output and assert clean parse

**Manual smoke (documented, not automated)**:
- Pick a real recent session, compact it with `--full-recent 5`
- `cd` to the source's cwd, run `claude`, `/resume` into the compacted session
- Verify: transcript renders, `ambix query` rehydration works on a stubbed turn, resumed conversation continues from the preserved tail

## Rollout

1. **Decide on rename-vs-remove for existing `compact`.** If unused locally, remove. Otherwise rename to `brief` in a separate commit so the rename is isolated from the new feature.
2. **Implement** per §Implementation shape with tests. Single PR.
3. **Ship + dogfood** — compact a few real sessions, manually verify `/resume` UX.
4. **A/B test**: run structural-split (this design) vs a bundled-prose variant (everything inside the divider's content body, no separate condensed entries) and compare agent quality on controlled probes. Structural-split is the baseline because a transcript of real entries gives the agent explicit turn boundaries, tool_use/tool_result pairing, and parent/child relationships to reason about, whereas a flat prose list collapses that into text. Measure before generalizing.

## Open questions / follow-ups

- **Stub density limits:** at what stub count does Claude lose structural fidelity? Probably fine at <200, unknown beyond. Measure during dogfooding.
- **Multi-compaction sessions:** if a session was already CC-compacted once and we re-compact it, does the resumed agent handle two `isCompactSummary` entries cleanly? Almost certainly yes (parse-cc's compaction detector walks all of them), but verify.
- **`ambix info` awareness:** annotate output when `isCompactSummary` entries are present in the target. Out of scope here, file separately.
- **Previewed-not-stubbed tool_results:** for specific tool types (e.g., small text outputs < 500 bytes), maybe inline the original content instead of stubbing. Defer until after A/B test shows structural-split is the right baseline.

## Validation log (from 2026-04-17 throwaway tests)

Two reproduction runs against CC 2.1.110 with synthetic compacted JSONLs confirmed:

1. **CC accepts the shape** — new UUID, fresh slug, multi-entry JSONL with `isCompactSummary` + mixed entry types — no loader errors, session appears in `/resume` list.
2. **Divider at split point is correct placement** — CC does NOT truncate at the divider; pre-divider entries remain in the model's context. Claude describes stubbed entries by turn and correctly reasons about their structure.
3. **Stub recognition** — Claude explicitly identifies stubs as truncation markers, does not hallucinate content, quotes the `ambix query` command from the stub verbatim when asked to rehydrate.
4. **Proactive rehydration** — when the user cannot re-derive the content (e.g., file path has no real underlying file), Claude runs `ambix query` unprompted. When both re-derivation and rehydration are valid, Claude presents both options.

All positive signals. The design thesis ("structural preservation + stubs + rehydration pointer") holds end-to-end.
