# Structural compact mode — DEPRECATED

**Status:** parked. Not reachable from the CLI or default `compactSession()` dispatch.

This directory holds the original structural-mode implementation of `ambix compact`. It's kept here so the code stays compilable and its tests don't bit-rot, but it's not what ships.

## What it was

Structural mode emitted every condensed source entry as a real JSONL log entry with its role preserved. `tool_result.content` bodies were swapped for `[COMPACTION STUB — {summary}, ~N bytes removed. Retrieve via: ambix query <orig-sid> <ix>]` strings; oversized `tool_use.input` string fields were truncated with a `<truncated>{preview}…</truncated>{marker}` wrapper.

## Why it was parked

During real-session smoke testing of the final PR, a pattern-match failure was observed:

1. The Claude Code harness trims its in-context display of prior `tool_use.input` values when those values exceed a visible-length threshold, using the same `<truncated>{preview}…</truncated>[COMPACTION STUB — ...]` shape that structural-mode compaction emitted inline.
2. When the agent later composes a new `Edit` tool call, it can pattern-match on what "an Edit to this file looked like" in its visible history. If the displayed history contains trimmed stubs, the agent can treat them as real input and echo them back into a new `Edit.new_string`.
3. In the PR's own smoke session, this caused three doc-file `Edit` calls to write literal `<truncated>…</truncated>[COMPACTION STUB — ...]` text into the files. The failure was caught before merge, but it was a near-miss for a silent data-loss bug.

Structural mode is the carrier because the failure-inducing shape lives inside real `tool_use.input` fields in real log entries — exactly where the harness's own display trimming applies and exactly where pattern-matching back into a new call happens.

## What ships instead

Bundled mode, rewritten to per-tool structured XML (`src/compact-session/bundled.ts` + `condense-input.ts` + `render-bundled-xml.ts`). Key differences from structural:

- Condensed turns collapse into ONE user-role message whose body is an `<ambix-compaction-marker>` preamble plus a `<turns>` XML block.
- Each `<tool_use>` uses per-tool element children (`<file_path>`, `<old_string>`, etc.) — distinct from CC's internal JSON tool_use shape.
- Truncation is signaled by a `truncated="<bytes>"` attribute on the field element; preview body ends with `…`. The `<truncated>…</truncated>[COMPACTION STUB — ...]` string pattern is never emitted.
- Rehydration instruction is in the preamble only — not repeated per field.
- Information parity: all tool_use input fields are represented (verbatim if small; `truncated` attribute + preview body if large). No inline loss vs structural.

## Can I still run structural?

Not via `ambix compact` — the `--mode` flag is gone. If you have a specific reason to generate a structural-shape JSONL, import `emit` directly from `@/compact-session/_experimental/structural/emit.js` and call it with `EmitOptions`. Expect no ongoing maintenance.

## Files here

- `emit.ts` — the structural emitter + divider placement + routing-ID rewrite
- `stub.ts` — the `[COMPACTION STUB — …]` string builder
- `summary.ts` — the `<ambix-compaction-marker>` divider entry constructor (structural variant)
- `truncate.ts` — the generic recursive size sweep applied to oversized fields
