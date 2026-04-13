// src/agent/lint.ts
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import type {
  Narrative,
  MainTask,
  Episode,
  Decision,
  Correction,
  FrictionPoint,
  Win,
  Unresolved,
  Verification,
} from "../artifact/types.js";

const TASK_STATUSES = new Set(["completed", "partial", "abandoned", "verified"]);
const EPISODE_KINDS = new Set([
  "research",
  "planning",
  "implementation",
  "debugging",
  "review",
  "housekeeping",
  "other",
]);
const CORRECTION_KINDS = new Set(["self_correction", "user_correction", "subagent_error"]);

/**
 * Validate the narrative file and its references against session.jsonl.
 * Returns an array of human-readable error strings; empty array means valid.
 */
export async function lintNarrative(tmpDir: string): Promise<string[]> {
  const errors: string[] = [];

  const narrativePath = path.join(tmpDir, "out", "narrative.json");
  const sessionPath = path.join(tmpDir, "session.jsonl");

  try {
    await access(narrativePath);
  } catch {
    errors.push(`out/narrative.json does not exist at ${narrativePath}`);
    return errors;
  }
  try {
    await access(sessionPath);
  } catch {
    errors.push(`session.jsonl does not exist at ${sessionPath}`);
    return errors;
  }

  const sessionText = await readFile(sessionPath, "utf8");
  const turnCount = sessionText.split("\n").filter((l) => l.trim().length > 0).length;
  const validIx = (n: unknown): n is number =>
    typeof n === "number" && Number.isInteger(n) && n >= 0 && n < turnCount;

  let narrative: unknown;
  try {
    narrative = JSON.parse(await readFile(narrativePath, "utf8"));
  } catch (err) {
    errors.push(`out/narrative.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
    return errors;
  }

  if (narrative === null || typeof narrative !== "object" || Array.isArray(narrative)) {
    errors.push("narrative root is not an object");
    return errors;
  }
  const n = narrative as Record<string, unknown>;

  const requiredKeys = [
    "summary",
    "main_tasks",
    "episodes",
    "decisions",
    "corrections",
    "verification",
    "friction_points",
    "wins",
    "unresolved",
  ];
  for (const key of requiredKeys) {
    if (!(key in n)) {
      errors.push(`narrative missing required field: ${key}`);
    }
  }
  if (errors.length > 0) return errors;

  if (typeof n.summary !== "string" || n.summary.trim().length === 0) {
    errors.push("narrative.summary must be a non-empty string");
  }

  validateArrayField<MainTask>(n.main_tasks, "main_tasks", errors, (task, path) => {
    if (typeof task.title !== "string") errors.push(`${path}.title must be a string`);
    if (typeof task.description !== "string") errors.push(`${path}.description must be a string`);
    if (!TASK_STATUSES.has(task.status)) {
      errors.push(`${path}.status must be one of ${[...TASK_STATUSES].join(", ")} (got "${task.status}")`);
    }
    validateRefs(task.refs, `${path}.refs`, validIx, errors);
  });

  validateArrayField<Episode>(n.episodes, "episodes", errors, (ep, path) => {
    if (typeof ep.title !== "string") errors.push(`${path}.title must be a string`);
    if (typeof ep.summary !== "string") errors.push(`${path}.summary must be a string`);
    if (!EPISODE_KINDS.has(ep.kind)) {
      errors.push(`${path}.kind must be one of ${[...EPISODE_KINDS].join(", ")} (got "${ep.kind}")`);
    }
    if (!Array.isArray(ep.ix_range) || ep.ix_range.length !== 2) {
      errors.push(`${path}.ix_range must be [start, end]`);
    } else {
      const [s, e] = ep.ix_range;
      if (!validIx(s)) errors.push(`${path}.ix_range[0]=${s} is not a valid ix`);
      if (!validIx(e)) errors.push(`${path}.ix_range[1]=${e} is not a valid ix`);
      if (typeof s === "number" && typeof e === "number" && s > e) {
        errors.push(`${path}.ix_range is inverted: [${s}, ${e}]`);
      }
    }
    validateRefs(ep.refs, `${path}.refs`, validIx, errors);
  });

  validateArrayField<Decision>(n.decisions, "decisions", errors, (d, path) => {
    if (typeof d.description !== "string") errors.push(`${path}.description must be a string`);
    if (typeof d.rationale !== "string") errors.push(`${path}.rationale must be a string`);
    validateRefs(d.refs, `${path}.refs`, validIx, errors);
  });

  validateArrayField<Correction>(n.corrections, "corrections", errors, (c, path) => {
    if (typeof c.description !== "string") errors.push(`${path}.description must be a string`);
    if (!CORRECTION_KINDS.has(c.kind)) {
      errors.push(`${path}.kind must be one of ${[...CORRECTION_KINDS].join(", ")} (got "${c.kind}")`);
    }
    validateRefs(c.refs, `${path}.refs`, validIx, errors);
  });

  const v = n.verification as Verification | undefined;
  if (!v || typeof v !== "object") {
    errors.push("verification must be an object");
  } else {
    if (typeof v.was_verified !== "boolean") errors.push("verification.was_verified must be a boolean");
    if (typeof v.how !== "string") errors.push("verification.how must be a string");
    validateRefs(v.refs, "verification.refs", validIx, errors);
  }

  validateArrayField<FrictionPoint>(n.friction_points, "friction_points", errors, (fp, path) => {
    if (typeof fp.description !== "string") errors.push(`${path}.description must be a string`);
    if (fp.attribution !== undefined && typeof fp.attribution !== "string") {
      errors.push(`${path}.attribution must be a string when present`);
    }
    validateRefs(fp.refs, `${path}.refs`, validIx, errors);
  });

  validateArrayField<Win>(n.wins, "wins", errors, (w, path) => {
    if (typeof w.description !== "string") errors.push(`${path}.description must be a string`);
    validateRefs(w.refs, `${path}.refs`, validIx, errors);
  });

  validateArrayField<Unresolved>(n.unresolved, "unresolved", errors, (u, path) => {
    if (typeof u.description !== "string") errors.push(`${path}.description must be a string`);
    validateRefs(u.refs, `${path}.refs`, validIx, errors);
  });

  return errors;
}

function validateArrayField<T>(
  value: unknown,
  name: string,
  errors: string[],
  validateItem: (item: T, path: string) => void
): void {
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array`);
    return;
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (item === null || typeof item !== "object") {
      errors.push(`${name}[${i}] must be an object`);
      continue;
    }
    validateItem(item as T, `${name}[${i}]`);
  }
}

function validateRefs(
  value: unknown,
  name: string,
  validIx: (n: unknown) => boolean,
  errors: string[]
): void {
  if (!Array.isArray(value)) {
    errors.push(`${name} must be an array of ix values`);
    return;
  }
  for (let i = 0; i < value.length; i++) {
    const v = value[i];
    if (!validIx(v)) {
      errors.push(`${name}[${i}] is not a valid ref (got ${JSON.stringify(v)})`);
    }
  }
}
