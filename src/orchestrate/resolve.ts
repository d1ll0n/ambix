// src/orchestrate/resolve.ts
import { access } from "node:fs/promises";
import path from "node:path";
import { findAllSessions } from "parse-cc";

/**
 * Resolve a session argument to an absolute `.jsonl` file path.
 *
 * Accepts either:
 *   - A file path (absolute or relative to cwd) — used as-is if it exists.
 *   - A session ID (full UUID or unambiguous prefix) — discovered via
 *     `findAllSessions` across `~/.claude/projects`.
 */
export async function resolveSessionPath(arg: string): Promise<string> {
  // If the arg looks like a path, try it as a file first.
  const looksLikePath = arg.includes(path.sep) || arg.includes("/") || arg.endsWith(".jsonl");
  if (looksLikePath) {
    const absolute = path.isAbsolute(arg) ? arg : path.resolve(arg);
    try {
      await access(absolute);
      return absolute;
    } catch {
      throw new Error(`session not found: ${arg}`);
    }
  }

  // Treat arg as a session ID (or prefix).
  const all = await findAllSessions();
  const matches = all.filter((s) => s.sessionId.startsWith(arg));
  if (matches.length === 0) {
    // Last-ditch: maybe it's a path without separators (single filename in cwd).
    const absolute = path.resolve(arg);
    try {
      await access(absolute);
      return absolute;
    } catch {
      throw new Error(`no session found with id: ${arg}`);
    }
  }
  if (matches.length > 1) {
    const list = matches.map((s) => `  ${s.sessionId}  ${s.path}`).join("\n");
    throw new Error(
      `ambiguous session id prefix "${arg}" matches ${matches.length} sessions:\n${list}`
    );
  }
  return matches[0].path;
}
