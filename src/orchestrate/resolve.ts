// src/orchestrate/resolve.ts
import { access } from "node:fs/promises";
import path from "node:path";

/**
 * Resolve a session argument to an absolute `.jsonl` file path.
 *
 * v1 accepts only existing file paths (absolute or relative to cwd).
 * UUID-based discovery is a future extension.
 */
export async function resolveSessionPath(arg: string): Promise<string> {
  const absolute = path.isAbsolute(arg) ? arg : path.resolve(arg);
  try {
    await access(absolute);
    return absolute;
  } catch {
    throw new Error(`session not found: ${arg}`);
  }
}
