# Spec: `ambix compact` — compacted session JSONL

**Status:** shipped (bundled-only, per-tool structured XML). Structural mode deprecated after real-session failure; parked under `src/compact-session/_experimental/structural/`.
**Date:** 2026-04-17
**Supersedes:** the existing `ambix compact` subcommand, which was renamed to `ambix brief`.

## Motivation

Claude Code's `/compact` produces a narrative text summary and continues the original session in place. Two problems with that:

1. It erases structural information. The summary is prose; the agent loses turn-by-turn pointers to "what was the exact Bash output at turn 47?"
2. It can't be inspected without opening the original session.

This feature produces an alternative: a **new, resumable session** where the condensed range is replaced with lightweight summary content that keeps navigable rehydration pointers to the source session.

### What shipped

A single render mode: **bundled per-tool structured XML.** The condensed range collapses into one user-role message whose body is an `<ambix-compaction-marker>` preamble plus a `<turns>` XML block. Each condensed source entry becomes a `<turn ix="N">` child; tool calls render as `<tool_use name="X" ix="N">` with per-tool structured field children (`<file_path>`, `<old_string>`, `<command>`, `<prompt>`, …). Tool_result entries render as `<tool_result ix="N" name="X">{condenser-summary}</tool_result>`. Small tool_use input values pass through verbatim; values over `--max-field-bytes` get a `truncated="<bytes>"` attribute + short preview body ending with `…`. Rehydration happens via `ambix query <orig-session-id> <ix>`, with instructions given once in the preamble.

Shared features: preserved tail verbatim (`--full-recent N`), Task* tool_use/result pass-through so CC replay rebuilds the live task list, `file-history-snapshot` drop, tasks-dir snapshot copy, parentUuid chain linearization, routing-ID regeneration.

Typical on-disk compaction: ~3-10% of source size.

### Design evolution (why not structural)

An earlier design emitted every condensed entry as a real JSONL log entry with tool_result bodies swapped for `[COMPACTION STUB — …]` strings and oversized tool_use input fields wrapped in `<truncated>{preview}…</truncated>{marker}` syntax. Real-session smoke testing revealed that exact shape matched how CC's harness trims in-context display of prior tool_use values — the agent would pattern-match the trimmed display back into new Edit calls, silently writing literal stub text into files. Three doc-file Edits wrote stub text before the failure was caught. See `_experimental/structural/DEPRECATED.md` for the full writeup.

The new bundled per-tool XML avoids this because:

1. The XML shape (`<tool_use name="Edit" ix="N"><file_path>…</file_path>…</tool_use>`) is structurally distinct from CC's internal tool_use JSON (`{"type":"tool_use","name":"Edit","input":{…}}`). Clearly "a summary," not a transcript.
2. Truncation uses an attribute (`truncated="<bytes>"`) on per-field elements, ending the preview with `…`. This is visually and structurally different from the harness's `<truncated>…</truncated>[COMPACTION STUB …]` display pattern, so an agent reading its own context can distinguish harness trimming from ambix compaction.
3. The rehydration instruction appears once in the preamble, not embedded in every stub, so the characteristic `ambix query <sid> <ix>` string doesn't litter every truncated field.

Validated via three `/resume` smoke tests on 2026-04-17 — the final one uses per-tool XML against a real 560 KB session. Claude Code's loader accepts the shape; agent quotes the marker correctly; rehydration via `ambix query` works; no pattern-match echo when the agent composes new tool calls.

## Goal

> Given a source session, emit a new session JSONL at `~/.claude/projects/<same-slug>/<new-uuid>.jsonl` containing a single bundled compaction-summary user-message (per-tool structured XML) + Task* pass-through entries + preserved tail. The new session is immediately usable via CC's `/resume`.

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

```
[bundled summary — 1 user entry]          ← <ambix-compaction-marker> preamble +
                                             <turns> XML list with per-tool structured
                                             <tool_use>/<tool_result> children
[Task* pass-throughs — 0..M entries]      ← TaskCreate/TaskUpdate/etc. tool_use + matched
                                             tool_result entries preserved VERBATIM (CC
                                             replays these on resume to rebuild task state)
[preserved entries — turns N-k+1..N]      ← all content passed through verbatim
```

`file-history-snapshot` entries are dropped from the condensed range (CC never feeds them to the model; they commonly add 8+ KB apiece). **Trade-off:** CC's rewind-with-code feature reconstructs file state from these snapshots, so rewinding into the condensed range is lost. Rewind inside the preserved tail still works. Tracked in §Open questions as a known limitation.

Empty condensed section (all turns within `--full-recent` window): skip turns/condensed content, still emit the bundled entry + preserved. Empty preserved section (`--full-recent 0`): still emit the bundled entry so the agent always has the explanatory preamble.

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

### Per-tool XML shape (inside the bundled message's `<turns>` block)

Every condensed source entry becomes one `<turn ix="N">` element. Tool calls and results render as distinct child elements:

**`<tool_use>`** — per-tool structured children. The renderer dispatches on `name`; each handler defines which fields are always-verbatim (scalar metadata) vs. truncation candidates (big strings).

```xml
<tool_use name="Read" ix="10">
  <file_path>src/foo.ts</file_path>
  <offset>0</offset>
  <limit>50</limit>
</tool_use>
<tool_result ix="11" name="Read">50 lines, ~2k tok</tool_result>
```

```xml
<tool_use name="Edit" ix="12">
  <file_path>src/x.ts</file_path>
  <old_string truncated="2048">function foo() {…</old_string>
  <new_string truncated="2103">function foo(x: number) {…</new_string>
</tool_use>
<tool_result ix="13" name="Edit">+12 -5 hunks</tool_result>
```

```xml
<tool_use name="Bash" ix="15">
  <command>git log --oneline | head -20</command>
  <description>view recent commits</description>
</tool_use>
<tool_result ix="16" name="Bash">23 lines, ~T tok</tool_result>
```

Errors surface as an attribute on the result:

```xml
<tool_result ix="16" name="Bash" error="true">Exit 1: permission denied</tool_result>
```

**Truncation semantics.** Fields listed as "truncation candidates" in the per-tool handler (Edit `old_string`/`new_string`, Write `content`, Task `prompt`, Bash `command`, etc.) get a `truncated="<bytes>"` attribute when their UTF-8 byte length exceeds `--max-field-bytes` (default 500). The element body carries the first `--preview-chars` chars (default 100) followed by `…`. Unknown MCP tools use a generic handler: top-level scalar fields pass through; oversized string values get the `truncated` treatment; nested objects are JSON-rendered with deep size-sweep.

**PRESERVE_TOOLS.** `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` / `TaskOutput` / `TaskStop` never appear inside `<turns>` — they pass through as real JSONL entries (see §File layout). CC replays them on resume to rebuild task state.

**Rehydration pointer.** Every `<turn>`, `<tool_use>`, and `<tool_result>` carries the source session's `ix` attribute. The bundled message's preamble tells the agent once: `ambix query <orig-session-id> N` substitutes the numeric ix. Not repeated per field.

**Note on `ix`:** this is the SOURCE session's 0-indexed turn number, not the new session's. That's what `ambix query` takes.

### Bundled user-message entry shape

> **Implementation note (2026-04-17):** an earlier draft used an entry with `isCompactSummary: true` + `isVisibleInTranscriptOnly: true`. Both flags caused CC to *hide* the content from the resuming agent — on real smoke tests the divider prose never made it into the model's context. The flags were removed; the shipped entry is a plain user-role message whose content is wrapped in `<ambix-compaction-marker>…</ambix-compaction-marker>` tags and includes the `<turns>` list.

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

**Content template.** The bundled message's body has two sections:

1. **Preamble** — explains what was compacted, how to rehydrate (`ambix query <orig-session-id> N` — substitute the ix), what the `<turns>` XML shape means, and the Task* pass-through guarantee:

```
<ambix-compaction-marker>
This session was compacted by ambix from <orig-session-id>.

Turns 0–<split-ix> were condensed into the `<turns>` block below.
Each `<turn ix="N">` summarizes ONE source entry. To retrieve the original content
of turn N, run: `ambix query <orig-session-id> N` (substitute the ix).

Condensed tool_use inputs use per-tool XML with `<field>value</field>` children.
Fields marked `truncated="<bytes>"` carry a short preview ending in `…` followed
by the original byte count — the real value is rehydratable via the command above.

Task-management tool calls (TaskCreate / TaskUpdate / …) are preserved verbatim as
real entries immediately after this message. This lets CC rebuild its live task list
on resume.

Source turns <split-ix+1>–<last> are preserved verbatim as real entries at the end of
this session (the last <N> rounds of the source conversation).

Do NOT infer or guess what a condensed turn contained — the XML here is a structured
summary, not the real tool invocation. Run the rehydration command when you need
actual content.

Continue the conversation from where it left off.
</ambix-compaction-marker>
```

2. **`<turns>` block** — one `<turn ix="N">` per condensed source entry, per the shape described in §Per-tool XML shape.

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
2. ✅ **Initial structural-mode implementation** — condensed range kept real entries with stubbed tool_results + size-swept oversized fields.
3. ✅ **Task* preserve allowlist** — `TaskCreate` / `TaskUpdate` / `TaskGet` / `TaskList` / `TaskOutput` / `TaskStop` pass through verbatim so CC can rebuild its live task list on resume.
4. ✅ **Initial bundled-mode implementation** — single user-role message + `<turns>` XML with one-liner summaries per tool.
5. ✅ **Dogfood smoke tests** — revealed that structural mode's inline `<truncated>…</truncated>[COMPACTION STUB …]` shape matched CC's harness display trimming, causing the agent to echo stub text into new Edit calls.
6. ✅ **Redesign**: drop structural; rebuild bundled with per-tool structured XML (attribute-based truncation marker, shape distinct from CC's internal tool_use AND the harness's trim pattern).
7. ✅ **Deprecate structural** — moved to `src/compact-session/_experimental/structural/` with `DEPRECATED.md`. CLI `--mode` flag removed.
8. **In progress:** dogfood real-session `/resume` to confirm the new shape resists the failure mode end-to-end.

## Open questions / follow-ups

- **Rewind-with-code limited to the preserved tail (known limitation).** CC's rewind feature reconstructs file content from `file-history-snapshot` entries, which we drop from the condensed range. A resumed agent cannot rewind-with-code back into the condensed range — only into the preserved tail. Document at CLI/README level. Fix path if it bites: keep `file-history-snapshot` entries within a configurable lookback window past the tail, or snapshot the current tree at compact time.
- **Mixed-block Task\* entries (concern).** An entry carrying a `Task*` block alongside a non-Task tool_use/result currently passes through whole (can't cleanly split a single entry across the bundle boundary without breaking CC's parentUuid chain). Tracked via `stats.mixedPreservedEntryCount`. Fix path: split at block granularity and emit the Task* slice as its own synthetic entry.
- **Multi-compaction sessions:** if a session was already CC-compacted once and we re-compact it, does the resumed agent handle the nested context cleanly? Verify.
- **`ambix info` awareness:** annotate output when the target session is an ambix compaction. Out of scope here, file separately.
- **Task\* ordering guarantees:** bundled mode emits Task* entries immediately after the bundled message and before the preserved tail, in source-chronological order. If CC ever starts caring about tool_use/result *interleaving* with non-Task turns for replay (currently it doesn't), the design needs revisiting.
- **Harness display trimming drift.** The current design's immunity to harness echo bugs depends on the harness using a specific trim format (`<truncated>…</truncated>[COMPACTION STUB …]`) that's structurally distinct from ours. If the harness changes its trim format to something matching ours, the defense weakens. Periodic smoke testing with fresh CC versions is the mitigation.

## Validation log

### 2026-04-17 throwaway tests (against CC 2.1.110)

Two reproduction runs with synthetic compacted JSONLs confirmed:

1. **CC accepts the shape** — new UUID, fresh slug, multi-entry JSONL with mixed entry types — no loader errors, session appears in `/resume` list. (An earlier throwaway using `isCompactSummary: true` + `isVisibleInTranscriptOnly: true` DID load, but caused CC to hide the divider content from the model; removing the flags fixed it — now the summary entry is plain user text wrapped in `<ambix-compaction-marker>` tags.)
2. **Divider at split point is correct placement** — CC does NOT truncate at the divider; pre-divider entries remain in the model's context. Claude describes stubbed entries by turn and correctly reasons about their structure.
3. **Stub recognition** — Claude explicitly identifies stubs as truncation markers, does not hallucinate content, quotes the `ambix query` command from the stub verbatim when asked to rehydrate.
4. **Proactive rehydration** — when the user cannot re-derive the content (e.g., file path has no real underlying file), Claude runs `ambix query` unprompted. When both re-derivation and rehydration are valid, Claude presents both options.

### 2026-04-17 real-session dogfood (against CC 2.1.112) — revealed structural failure

While implementing this feature inside a long-running CC session, the structural-mode failure mode surfaced:

- The harness trims its display of large prior `tool_use.input` values in the agent's own context using the shape `<truncated>{preview}…</truncated>[COMPACTION STUB — ... ambix query <sid> <ix>]`.
- That matched structural mode's inline truncation shape exactly.
- Three separate `Edit` calls the agent made to documentation files wrote literal `<truncated>…</truncated>[COMPACTION STUB — ...]` text into the files — the agent pattern-matched on what "an Edit to this file looked like" in its visible history and echoed the trim pattern into a new `Edit.new_string`.

### 2026-04-17 per-tool XML redesign — sanity scan

Ix-coverage scan on a ~1200-entry session with `--full-recent 1`:

- 967 ix values emitted in the bundled `<turns>` block.
- Of 249 source entries missing from the bundle's ix range: 111 `system`, 110 `file-history-snapshot`, 9 `custom-title`, 9 `pr-link`, 7 `agent-name`, 3 `last-prompt`.
- Zero missing conversational entries (user/assistant text, tool_use, tool_result) — everything the model would care about on resume is represented.

The design thesis — "structured rehydration pointers in a shape distinct from both CC's tool_use JSON and the harness's display trim" — appears intact. End-to-end `/resume` smoke (task #20) is the final check before flipping PR to ready.
