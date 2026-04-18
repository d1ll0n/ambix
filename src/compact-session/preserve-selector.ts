// src/compact-session/preserve-selector.ts
//
// Parse and apply the user-supplied `--preserve <kind>:<pattern>` flag.
//
// Two selector kinds are supported:
//
//   tool:<glob>  — matches tool_use.name (on assistant entries) OR the
//                  tool_name of a tool_result (looked up via tool_use_id).
//                  Effect: the entry stays inside the bundled <turns> block,
//                  but its input fields pass through verbatim (no truncation)
//                  and the tool_result body is the raw content.
//
//   type:<glob>  — matches parse-cc's entry.type field. Effect: the WHOLE
//                  entry passes through as a real JSONL entry (not rendered
//                  into the bundled XML), the same path Task* entries take.
//
// Patterns are glob-style (`*` matches any sequence, `?` matches one char).
// Case-sensitive. Whole-name match (not substring).

/** One parsed selector. */
export type PreserveSelector =
  | { kind: "tool"; pattern: RegExp }
  | { kind: "type"; pattern: RegExp };

const SUPPORTED_KINDS = ["tool", "type"] as const;

/**
 * Parse a raw `<kind>:<pattern>` string. Throws on unknown kind or missing
 * colon. The caller (CLI) wraps the throw into a user-facing error message.
 */
export function parseSelector(raw: string): PreserveSelector {
  const i = raw.indexOf(":");
  if (i <= 0) {
    throw new Error(`--preserve must be <kind>:<pattern> (e.g. tool:mcp__*), got: ${raw}`);
  }
  const kind = raw.slice(0, i);
  const pattern = raw.slice(i + 1);
  if (pattern.length === 0) {
    throw new Error(`--preserve: pattern must be non-empty, got: ${raw}`);
  }
  if (!(SUPPORTED_KINDS as readonly string[]).includes(kind)) {
    throw new Error(
      `--preserve: unknown kind "${kind}" (got ${raw}). Supported: ${SUPPORTED_KINDS.join(", ")}`
    );
  }
  return { kind: kind as "tool" | "type", pattern: globToRegex(pattern) };
}

/**
 * Convert a glob (`*`, `?`, literal) to an anchored case-sensitive regex.
 * Reserved regex metacharacters are escaped. `*` → `.*`, `?` → `.`.
 */
export function globToRegex(glob: string): RegExp {
  const reserved = /[.+^${}()|[\]\\]/g;
  let body = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") body += ".*";
    else if (ch === "?") body += ".";
    else if (reserved.test(ch)) body += `\\${ch}`;
    else body += ch;
    reserved.lastIndex = 0; // single-char test; reset to avoid sticky state
  }
  return new RegExp(`^${body}$`);
}

/** True if any of the tool selectors matches `name`. */
export function matchesToolSelector(
  name: string,
  selectors: ReadonlyArray<PreserveSelector>
): boolean {
  for (const s of selectors) {
    if (s.kind === "tool" && s.pattern.test(name)) return true;
  }
  return false;
}

/** True if any of the type selectors matches `entryType`. */
export function matchesTypeSelector(
  entryType: string,
  selectors: ReadonlyArray<PreserveSelector>
): boolean {
  for (const s of selectors) {
    if (s.kind === "type" && s.pattern.test(entryType)) return true;
  }
  return false;
}

/** Partition selectors by kind (handy when plumbing them into different call sites). */
export function splitByKind(selectors: ReadonlyArray<PreserveSelector>): {
  tool: PreserveSelector[];
  type: PreserveSelector[];
} {
  const tool: PreserveSelector[] = [];
  const type: PreserveSelector[] = [];
  for (const s of selectors) {
    if (s.kind === "tool") tool.push(s);
    else type.push(s);
  }
  return { tool, type };
}
