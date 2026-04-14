// src/query/show.ts
import type { Session } from "parse-claude-logs";
import { getFieldByPath } from "./format.js";

/** Options for the show query. */
export interface ShowOptions {
  ix: number;
  /** Optional dot/bracket path into the entry (e.g. "message.content[0].input.content"). */
  field?: string;
}

/**
 * Return either the entire entry at ix, or a specific field within it
 * when `field` is provided.
 *
 * Throws when ix is out of range. Returns `undefined` when a valid ix
 * has no value at the requested field path.
 */
export async function queryShow(session: Session, opts: ShowOptions): Promise<unknown> {
  const entries = await session.messages();
  if (opts.ix < 0 || opts.ix >= entries.length) {
    throw new Error(`ix ${opts.ix} out of range (session has ${entries.length} entries)`);
  }
  const entry = entries[opts.ix];
  if (!opts.field) return entry;
  return getFieldByPath(entry, opts.field);
}
