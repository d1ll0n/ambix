#!/usr/bin/env node
// src/agent/lint-cli.ts
import { lintNarrative } from "./lint.js";

async function main(): Promise<number> {
  const tmpDir = process.argv[2] ?? process.cwd();
  const errors = await lintNarrative(tmpDir);
  if (errors.length === 0) {
    process.stdout.write("lint-output: OK\n");
    return 0;
  }
  process.stderr.write("lint-output failed:\n");
  for (const e of errors) {
    process.stderr.write(`  - ${e}\n`);
  }
  return 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
);
