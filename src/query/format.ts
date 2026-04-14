// src/query/format.ts
import type { QueryMatch, QueryOutputFormat } from "./types.js";

/** Render a list of matches in the requested format. */
export function formatMatches(
  matches: ReadonlyArray<QueryMatch>,
  format: QueryOutputFormat
): string {
  if (format === "count") return `${matches.length}\n`;
  if (format === "full") {
    if (matches.length === 0) return "";
    return matches.map((m) => JSON.stringify(m)).join("\n") + "\n";
  }
  // compact
  if (matches.length === 0) return "";
  return matches
    .map((m) => `${String(m.ix).padStart(5, " ")}  ${m.kind}  ${m.summary}`)
    .join("\n") + "\n";
}

/**
 * Read a value from an object via a dot/bracket path like
 * `content[0].input.file_path`. Returns `undefined` for any missing
 * segment or out-of-range index.
 */
export function getFieldByPath(obj: unknown, pathStr: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  const segments = parsePath(pathStr);
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[seg];
    } else {
      if (typeof cur !== "object") return undefined;
      cur = (cur as Record<string, unknown>)[seg];
    }
  }
  return cur;
}

function parsePath(pathStr: string): Array<string | number> {
  const out: Array<string | number> = [];
  const parts = pathStr.split(".");
  for (const part of parts) {
    // Each part may be "name" or "name[0]" or "name[0][1]"
    const match = /^([^[]*)((?:\[\d+\])*)$/.exec(part);
    if (!match) continue;
    const name = match[1];
    const indices = match[2];
    if (name.length > 0) out.push(name);
    if (indices) {
      const idxMatches = indices.matchAll(/\[(\d+)\]/g);
      for (const im of idxMatches) out.push(parseInt(im[1], 10));
    }
  }
  return out;
}
