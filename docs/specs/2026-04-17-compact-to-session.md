# Spec: `ambix compact` — compacted session JSONL

**Status:** shipped (bundled + structural modes)
**Date:** 2026-04-17
**Supersedes:** the existing `ambix compact` subcommand, which was renamed to `ambix brief`.

## Motivation

Claude Code's `/compact` produces a narrative text summary and continues the original session in place. Two problems with that:

1. It erases structural information. The summary is prose; the agent loses turn-by-turn pointers to "what was the exact Bash output at turn 47?"
2. It can't be inspected without opening the original session.

This feature produces an alternative: a **new, resumable session** where the condensed range is replaced with lightweight summary content that keeps navigable rehydration pointers to the source session.

### What shipped

The design process surfaced that there are two reasonable representations of the condensed range, each with genuine tradeoffs. Both are implemented; one is the default.

- **`--mode bundled` (default).** All condensed entries collapse into a single user-role message containing an `<ambix-compaction-marker>` preamble + a `<turns>` XML list of per-entry summaries. Simplest for the resumed agent, smallest on disk (~3-10% of source), structurally immune to unknown-tool bloat. Task* entries still pass through as real entries.
- **`--mode structural`.** Every condensed entry stays as a real log entry with its role preserved; tool_result bodies become `[COMPACTION STUB — …]` strings; oversized tool_use input fields are truncated with a preview + rehydration marker. Larger on disk (~25-30% of source) but keeps per-entry structure for downstream tooling that walks the transcript.

Both modes share: preserved tail verbatim (`--full-recent N`), Task* tool_use/result pass-through so CC replay rebuilds the live task list, file-history-snapshot drop, tasks-dir snapshot copy, parentUuid chain linearization, routing-ID regeneration.

The rest of this doc walks through the design in detail. Most of it applies to both modes; sections that are mode-specific are marked.

Validated via two throwaway /resume tests on 2026-04-17 (see §Validation). Claude Code's loader accepts the shape; Claude recognizes stubs as truncation markers; proactive rehydration works.

## Goal

> Given a source session, emit a new session JSONL at `~/.claude/projects/<same-slug>/<new-uuid>.jsonl` containing (bundled mode) a single compaction-summary user-message + Task* pass-throughs + preserved tail, or (structural mode) per-entry condensed records + divider + preserved tail. The new session is immediately usable via CC's `/resume`.

## Non-goals

- Replacing CC's native `/compact` in-place behavior. This feature is additive and spawns a new session; it does not mutate the source.
- Copying read-only sidecar state (subagent logs, spill files, file-history blobs). Rehydration goes back to the original session's copies. Tasks are handled separately — see "Tasks sidecar snapshot" below.
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

**Structural mode:**

```
[condensed entries — turns 0..N-k]        ← user/assistant/tool_use entries pass through;
                                             tool_result bodies → COMPACTION STUB strings;
                                             oversized tool_use inputs truncated with preview
[divider — 1 entry]                       ← user entry wrapped in
                                             <ambix-compaction-marker>…</ambix-compaction-marker>
[preserved entries — turns N-k+1..N]      ← all content passed through verbatim
```

**Bundled mode:**

```
[bundled summary — 1 user entry]          ← <ambix-compaction-marker> preamble +
                                             <turns> XML list (one <turn ix="N" kind="..."
                                             name="...">…</turn> per condensed source entry)
[Task* pass-throughs — 0..M entries]      ← TaskCreate/TaskUpdate/etc. tool_use + matched
                                             tool_result entries preserved VERBATIM (CC
                                             replays these on resume to rebuild task state)
[preserved entries — turns N-k+1..N]      ← all content passed through verbatim
```

Both modes drop `file-history-snapshot` entries from the condensed range (CC never feeds them to the model; they commonly add 8+ KB apiece). **Trade-off:** CC's rewind-with-code feature reconstructs file state from these snapshots, so rewinding into the condensed range is lost. Rewind inside the preserved tail still works. Tracked in §Open questions as a known limitation.

Empty condensed section (all turns within `--full-recent` window): skip turns/condensed content, still emit the summary entry + preserved. Empty preserved section (`--full-recent 0`): still emit summary so the agent always has the explanatory preamble.

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

Where `{condenser-summary}` comes from `src/brief/condensers.ts::condenseToolUse(name, input, originalResult)`. That function already handles Read/Edit/Write/Grep/Glob/Bash/Task/TodoWrite/Playwright + falls back to `condenseGeneric(name, input, result)` for unknown tools (prints `{toolName} {firstScalarKey}=val [error?]`).

Examples:
- Read: `[COMPACTION STUB — Read src/foo.ts (offset=0, limit=50) — 50 lines, ~2k tok, 2048 bytes removed. Retrieve via: ambix query <id> 47]`
- Bash: `[COMPACTION STUB — Bash "git log --oneline" — 23 lines, 1204 bytes removed. Retrieve via: ambix query <id> 51]`
- Unknown: `[COMPACTION STUB — mcp_foo__do_thing key=value, 8192 bytes removed. Retrieve via: ambix query <id> 82]`

`is_error` and `tool_use_id` on the tool_result block stay unchanged.

**Note on `ix`:** this is the SOURCE session's 0-indexed turn number, not the new session's. That's what `ambix query` takes.

### Divider / summary entry

> **Implementation note (2026-04-17):** the original spec below proposed a user entry carrying `isCompactSummary: true` + `isVisibleInTranscriptOnly: true`. Both flags caused CC to *hide* the content from the resuming agent — on real smoke tests the divider prose never made it into the model's context. The flags were removed; the shipped entry is a plain user-role message whose content is wrapped in `<ambix-compaction-marker>…</ambix-compaction-marker>` tags (so downstream tools can still identify it) and nothing else. In bundled mode this same user message also carries the `<turns>` list.

```json
{
  "type": "user",
  "parentUuid": "<last condensed entry uuid, or null if no condensed>",
  "uuid": "<fresh>",
  "sessionId": "<new session UUID>",
  "timestamp": "<now>",
  "message": { "role": "user", "content": "<ambix-compaction-marker>\n<prose — see template below>\n</ambix-compaction-marker>\n<turns>...</turns>" },
  "userType": "external",
  "isMeta": false,
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

## Tasks sidecar snapshot

Claude Code keys per-session task state by session UUID, storing files under `~/.claude/tasks/<sessionId>/` (one `<id>.json` per task plus a `.highwatermark` counter). Tasks are live state the harness mutates at runtime via `TaskCreate` / `TaskUpdate`; a session with no matching tasks directory has no visible tasks.

When `ambix compact` emits a new session UUID, it deep-copies the source's tasks directory to `~/.claude/tasks/<new-session-id>/` so the compacted session starts with the source's task state intact. The copy is independent — subsequent task mutations on either the source or the compacted session affect only that side's directory. This keeps the source fully available for continued use or forking.

No-op when the source has no tasks directory. The copy is skipped in `--dry-run` mode.

**Uniqueness guarantee.** `compactSession` generates a fresh session UUID and verifies that both its derived JSONL path and its tasks directory are unoccupied before using it, re-rolling if either collides. An explicit `--output` pointing at a pre-existing file is an error — the command refuses to overwrite it.

## Round boundaries (for `--full-recent N`)

A "round" starts at each top-level user entry that is NOT a tool_result wrapper (`isMeta !== true`). The round extends through all subsequent assistant turns and tool_result user entries until the next top-level user turn or end-of-session. This matches `src/brief/rounds.ts`'s existing `groupIntoRounds` logic — reuse it directly.

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
  tasks.ts           — deep-copy the source's tasks sidecar to the new session
  types.ts           — CompactSessionOptions, CompactSessionResult
src/cli.ts           — add `compact` subcommand dispatcher (rename existing → `brief`)
```

Shared helpers lifted from `src/brief/`:
- `rounds.ts::groupIntoRounds` + `buildToolResultIndex`
- `condensers.ts::condenseToolUse`

From parse-cc: `defaultTasksDir` + `findTasksDir` for locating the source's tasks directory.

## Validation strategy

**Unit tests** (vitest):
- Condensed tool_result content is a stub string matching the expected shape
- Preserved tool_result content passes through unchanged
- parentUuid chain is linear and consistent (first = null, each subsequent = prev.uuid)
- sessionId on every entry = new UUID
- Summary entry's content wraps prose in `<ambix-compaction-marker>` tags (no `isCompactSummary`/`isVisibleInTranscriptOnly` flags — they make CC hide the content)
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

1. ✅ **Rename existing `compact` → `brief`** in a separate commit so the rename is isolated from the new feature.
2. ✅ **Structural-mode implementation** — condensed range keeps real entries with stubbed tool_results + size-swept oversized fields.
3. ✅ **Task* preserve allowlist** — `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` / `TaskOutput` / `TaskStop` pass through verbatim regardless of mode so CC can rebuild its live task list on resume.
4. ✅ **Bundled-mode implementation** — single user-role message carries the condensed summary; default mode.
5. ✅ **`--mode bundled|structural` CLI flag.**
6. **In progress: dogfood.** Compact real sessions, manually verify `/resume` UX, report file-size compaction ratios. First real-session run (492 KB → 18.7 KB bundled / 137 KB structural) on 2026-04-17.
7. **Pending: A/B quality comparison.** Bundled is the default on a priori reasoning (simpler, shape-immune, smaller) but the quality tradeoff vs. structural has not been measured with controlled agent probes. Open-ended; use bundled as the baseline since it ships as default.

## Open questions / follow-ups

- **Rewind-with-code limited to the preserved tail (known limitation).** CC's rewind feature reconstructs file content from `file-history-snapshot` entries, which we drop from the condensed range (dropping saves megabytes and CC doesn't feed them to the model). A resumed agent cannot rewind-with-code back into the condensed range — only into the preserved tail. Document at CLI/README level so users know. If it turns into a real friction point, a fix path is: keep `file-history-snapshot` entries that fall within a configurable lookback window past the tail, or snapshot the current tree at compact time.
- **Mixed-block Task* entries (concern).** An entry that carries a `Task*` block *alongside* a non-Task tool_use/result currently passes through whole (we can't cleanly split a single entry across the bundle boundary without breaking CC's parentUuid chain). Tracked via `stats.mixedPreservedEntryCount` so we can detect if it's a real bloat source in practice. Fix path: split at block granularity and emit the Task* slice as its own synthetic entry.
- **Stub density limits:** at what stub count does Claude lose structural fidelity? Probably fine at <200, unknown beyond. Measure during dogfooding — primarily relevant for structural mode.
- **Multi-compaction sessions:** if a session was already CC-compacted once and we re-compact it, does the resumed agent handle the nested context cleanly? Verify.
- **`ambix info` awareness:** annotate output when the target session is compacted. Out of scope here, file separately.
- **Task* ordering guarantees:** bundled mode emits Task* entries immediately after the bundled message and before the preserved tail. They're in source-chronological order among themselves, so CC's replay reaches the correct final state. If CC ever starts caring about tool_use/result *interleaving* with non-Task turns for replay (currently it doesn't), the design needs revisiting.

## Validation log (from 2026-04-17 throwaway tests)

Two reproduction runs against CC 2.1.110 with synthetic compacted JSONLs confirmed:

1. **CC accepts the shape** — new UUID, fresh slug, multi-entry JSONL with mixed entry types — no loader errors, session appears in `/resume` list. (An earlier throwaway using `isCompactSummary: true` + `isVisibleInTranscriptOnly: true` DID load, but caused CC to hide the divider content from the model; removing the flags fixed it — now the summary entry is plain user text wrapped in `<ambix-compaction-marker>` tags.)
2. **Divider at split point is correct placement** — CC does NOT truncate at the divider; pre-divider entries remain in the model's context. Claude describes stubbed entries by turn and correctly reasons about their structure.
3. **Stub recognition** — Claude explicitly identifies stubs as truncation markers, does not hallucinate content, quotes the `ambix query` command from the stub verbatim when asked to rehydrate.
4. **Proactive rehydration** — when the user cannot re-derive the content (e.g., file path has no real underlying file), Claude runs `ambix query` unprompted. When both re-derivation and rehydration are valid, Claude presents both options.

All positive signals. The design thesis ("structural preservation + stubs + rehydration pointer") holds end-to-end.
