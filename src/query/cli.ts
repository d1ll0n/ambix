#!/usr/bin/env node
// src/query/cli.ts
import { runQuery } from "./index.js";

runQuery(process.argv.slice(2)).then(
  ({ code, output }) => {
    process.stdout.write(output);
    process.exit(code);
  },
  (err) => {
    process.stderr.write(`ambix query: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(2);
  }
);
