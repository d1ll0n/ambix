// src/compact-session/render-bundled-xml.ts
//
// XML rendering for the bundled mode's `<turn>` bodies. Takes a
// CondensedToolInput (from condense-input.ts) and emits a self-describing
// XML element. Goals:
//
//   1. Distinct from CC's internal tool_use JSON shape — clearly "a summary,"
//      not something the resumed agent might mistake for a real call it made.
//   2. Truncation marked by a machine-readable attribute (`truncated="<bytes>"`)
//      on the field element, NOT by an inline `[COMPACTION STUB …]` string
//      pattern. The string pattern is a known source of agent pattern-match
//      echo bugs when the harness uses the same shape for its own display
//      trimming.
//   3. One retrieval instruction, lives in the marker preamble — not repeated
//      per element.
//   4. No `id=` on tool_use/tool_result — rehydration via `ix`.

import type { ToolResultBlock, ToolUseBlock } from "parse-cc";
import type { CondensedField, CondensedToolInput } from "./condense-input.js";

/**
 * Render a condensed tool_use as a single `<tool_use>` XML element with per-field children.
 *
 * Shape: `<tool_use name="X" ix="N"><field>value</field>...</tool_use>`.
 * Truncated fields use `<field truncated="<bytes>">preview…</field>`.
 */
export function renderToolUseXml(
  block: ToolUseBlock,
  ix: number,
  condensed: CondensedToolInput
): string {
  const attrs = ` name="${xmlAttr(block.name)}" ix="${ix}"`;
  if (condensed.fields.length === 0) {
    return `<tool_use${attrs}/>`;
  }
  const lines = [`<tool_use${attrs}>`];
  for (const field of condensed.fields) {
    lines.push(renderField(field));
  }
  lines.push("</tool_use>");
  return lines.join("\n");
}

/**
 * Render a tool_result as `<tool_result ix="N" name="X">one-liner</tool_result>`.
 * Adds `error="true"` for failed calls. The body carries the condenser summary
 * (diff stats, line counts, token estimates — computed from the tool_use input
 * + result); full content is always rehydratable via `ambix query`.
 */
export function renderToolResultXml(
  block: ToolResultBlock,
  ix: number,
  toolName: string,
  summary: string
): string {
  const attrs = ` ix="${ix}" name="${xmlAttr(toolName)}"${block.is_error ? ' error="true"' : ""}`;
  const body = xmlText(summary);
  if (body.length === 0) {
    return `<tool_result${attrs}/>`;
  }
  return `<tool_result${attrs}>${body}</tool_result>`;
}

// ---------------------------------------------------------------------------
// Field rendering
// ---------------------------------------------------------------------------

function renderField(field: CondensedField): string {
  const tag = xmlTagName(field.name);
  if (field.kind === "truncated") {
    // Preview body ends with horizontal ellipsis to make the clipped nature
    // visually obvious even if an agent strips the `truncated=` attribute.
    const preview = field.preview.length > 0 ? `${xmlText(field.preview)}…` : "";
    return `<${tag} truncated="${field.origBytes}">${preview}</${tag}>`;
  }
  const { value } = field;
  if (value === null) return `<${tag}/>`;
  if (typeof value === "string") {
    return `<${tag}>${xmlText(value)}</${tag}>`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return `<${tag}>${String(value)}</${tag}>`;
  }
  // Object / array: emit as JSON inside the tag. condense-input.ts has
  // already size-swept any oversized leaf strings with a `[truncated: <N>
  // bytes; preview: <…>]` sentinel — deliberately not the
  // `[COMPACTION STUB …]` pattern that caused the original failure.
  return `<${tag}>${xmlText(JSON.stringify(value))}</${tag}>`;
}

// ---------------------------------------------------------------------------
// XML escaping
// ---------------------------------------------------------------------------

// XML 1.0 (§2.2) illegal code points: C0 controls except \t/\n/\r, noncharacters
// U+FFFE/U+FFFF, and unpaired surrogates. Tool output sometimes carries
// control bytes (ANSI sequences, NULs); strip them so the `<turns>` block
// stays parseable by a conforming XML reader.
const XML_ILLEGAL_RE = new RegExp(
  [
    "[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\uFFFE\\uFFFF]",
    "[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])",
    "(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]",
  ].join("|"),
  "g"
);

function stripIllegal(s: string): string {
  return s.replace(XML_ILLEGAL_RE, "");
}

function xmlText(s: string): string {
  return stripIllegal(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xmlAttr(s: string): string {
  return stripIllegal(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Sanitize a field name for use as an XML tag. MCP tools sometimes use
 * hyphens or other punctuation in parameter names; XML requires
 * `[A-Za-z_][A-Za-z0-9_.-]*` for tag names. Replace anything outside that
 * set with `_`, and prefix a leading digit with `_`.
 */
function xmlTagName(name: string): string {
  let cleaned = name.replace(/[^A-Za-z0-9_.-]/g, "_");
  if (cleaned.length === 0) cleaned = "field";
  if (/^[0-9-]/.test(cleaned)) cleaned = `_${cleaned}`;
  return cleaned;
}
