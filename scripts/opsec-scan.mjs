#!/usr/bin/env node
// scripts/opsec-scan.mjs
//
// Pre-publish / pre-push secret and PII scanner for ambix.
//
// Walks ALL committed history (every unique blob + commit metadata)
// AND staged-but-not-yet-committed files, checking for patterns that
// should not appear in a public repository:
//
//   HARD FAIL:  /root/ paths, email addresses, ~/.claude/projects
//               directory names, session UUIDs from those projects,
//               "superpowers" in file paths or content
//   WARN:       username (d1ll0n / dillon)
//
// Project names and session IDs are gathered at runtime from the
// local filesystem so the checks stay current without hardcoding.
//
// Usage:
//   node scripts/opsec-scan.mjs             # full: all history + staged
//   node scripts/opsec-scan.mjs --unpushed  # commits not yet on remote + HEAD (for pre-push)
//   node scripts/opsec-scan.mjs --head      # HEAD tree only + staged
//   node scripts/opsec-scan.mjs --staged    # staged only (fastest)
//
// Exit: 0 = clean, 1 = hard-fail found, 2 = internal error.

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

function gitBuf(args, opts = {}) {
  return execFileSync("git", args, { maxBuffer: 64 * 1024 * 1024, ...opts });
}

// ---------------------------------------------------------------------------
// Runtime-gathered secrets
// ---------------------------------------------------------------------------

function discoverProjectNames() {
  const dir = join(homedir(), ".claude", "projects");
  try {
    return readdirSync(dir).filter((n) => !n.startsWith("."));
  } catch {
    return [];
  }
}

function discoverSessionIds() {
  const dir = join(homedir(), ".claude", "projects");
  const ids = new Set();
  let projects;
  try {
    projects = readdirSync(dir);
  } catch {
    return [];
  }
  for (const p of projects) {
    try {
      for (const f of readdirSync(join(dir, p))) {
        if (f.endsWith(".jsonl")) ids.add(f.slice(0, -6));
      }
    } catch {
      /* skip unreadable dirs */
    }
  }
  return [...ids];
}

// ---------------------------------------------------------------------------
// Build checks
// ---------------------------------------------------------------------------

const ESC = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function buildChecks() {
  const projects = discoverProjectNames();
  const sessions = discoverSessionIds();

  const checks = [
    { name: "root path (/root/)", severity: "fail", re: /\/root\//g },
    { name: "username", severity: "warn", re: /\b(d1ll0n|dillon)\b/gi },
    { name: "email address", severity: "fail", re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
    { name: "superpowers ref", severity: "fail", re: /superpowers/gi },
  ];
  // Project names: only match slugs ≥10 chars (shorter ones like "-root"
  // cause false positives on flags like --tmp-root). Require the slug to
  // NOT be surrounded by alphanumerics or hyphens so it matches as a
  // whole token, not a substring of something else.
  const longProjects = projects.filter((p) => p.length >= 10);
  if (longProjects.length) {
    checks.push({
      name: "claude project name",
      severity: "fail",
      re: new RegExp(
        longProjects
          .sort((a, b) => b.length - a.length) // longest first
          .map((p) => `(?<![a-zA-Z0-9-])${ESC(p)}(?![a-zA-Z0-9-])`)
          .join("|"),
        "g"
      ),
    });
  }
  if (sessions.length) {
    checks.push({
      name: "claude session id",
      severity: "fail",
      re: new RegExp(sessions.map(ESC).join("|"), "g"),
    });
  }
  return { checks, projects, sessions };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

const SELF_PATH = "scripts/opsec-scan.mjs";

// Paths to skip entirely — machine-generated files whose content is
// not user-authored and is full of third-party metadata (emails in
// npm package manifests, etc.).
const SKIP_PATHS = new Set(["package-lock.json"]);

function scanText(text, checks, location) {
  const issues = [];
  for (const check of checks) {
    for (const match of text.matchAll(check.re)) {
      const prefix = text.slice(0, match.index);
      const lineNum = prefix.split("\n").length;
      const lineStart = prefix.lastIndexOf("\n") + 1;
      const lineEnd = text.indexOf("\n", match.index);
      const line = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd).trim();
      issues.push({
        check: check.name,
        severity: check.severity,
        location,
        line: lineNum,
        match: match[0],
        context: line.slice(0, 140),
      });
    }
  }
  return issues;
}

function isBinary(buf) {
  const len = Math.min(buf.length, 8192);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// History scan
// ---------------------------------------------------------------------------

function scanHistory(checks) {
  const issues = [];
  let blobCount = 0;
  let msgCount = 0;

  // 1. All unique blobs across history
  //    rev-list --objects --all emits "<sha>" for commits/trees,
  //    "<sha> <path>" for blobs.
  const objectList = git(["rev-list", "--objects", "--all"]);
  const blobsBySha = new Map(); // sha -> Set<path>
  for (const line of objectList.split("\n")) {
    const idx = line.indexOf(" ");
    if (idx === -1) continue;
    const sha = line.slice(0, idx);
    const path = line.slice(idx + 1);
    if (!blobsBySha.has(sha)) blobsBySha.set(sha, new Set());
    blobsBySha.get(sha).add(path);
  }

  for (const [sha, paths] of blobsBySha) {
    // Path-level checks (applies even if blob is binary)
    for (const p of paths) {
      if (p === SELF_PATH || SKIP_PATHS.has(p)) continue;
      issues.push(...scanText(p, checks, `${p} (path)`));
    }

    // Content-level checks
    const shouldSkip = [...paths].every((p) => p === SELF_PATH || SKIP_PATHS.has(p));
    if (shouldSkip) continue;

    let buf;
    try {
      buf = gitBuf(["cat-file", "blob", sha], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      continue;
    }
    if (buf.length > 2 * 1024 * 1024 || isBinary(buf)) continue;
    blobCount++;
    const content = buf.toString("utf8");
    const label = [...paths][0];
    issues.push(...scanText(content, checks, label));
  }

  // 2. Commit messages (body only — author/committer metadata is
  //    intentionally excluded; those fields are standard git metadata
  //    visible in `git log` on any public repo and aren't secrets).
  const logSep = "<<<OPSEC_SEP>>>";
  const log = git(["log", "--all", `--format=%H%x00%B${logSep}`]);
  for (const chunk of log.split(logSep)) {
    if (!chunk.trim()) continue;
    const nullIdx = chunk.indexOf("\x00");
    if (nullIdx === -1) continue;
    const hash = chunk.slice(0, nullIdx).trim();
    const body = chunk.slice(nullIdx + 1);
    if (!body.trim()) continue;
    msgCount++;
    issues.push(...scanText(body, checks, `commit ${hash.slice(0, 8)}`));
  }

  return { issues, blobCount, msgCount };
}

// ---------------------------------------------------------------------------
// Staged scan
// ---------------------------------------------------------------------------

function scanStaged(checks) {
  const issues = [];
  let count = 0;

  let names;
  try {
    names = git(["diff", "--cached", "--name-only", "-z"]).split("\0").filter(Boolean);
  } catch {
    return { issues, count };
  }

  for (const p of names) {
    if (p === SELF_PATH) continue;
    count++;
    issues.push(...scanText(p, checks, `staged ${p} (path)`));
    let buf;
    try {
      buf = gitBuf(["show", `:${p}`]);
    } catch {
      continue;
    }
    if (buf.length > 2 * 1024 * 1024 || isBinary(buf)) continue;
    issues.push(...scanText(buf.toString("utf8"), checks, `staged ${p}`));
  }
  return { issues, count };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(allIssues, stats) {
  const { blobCount, msgCount, stagedCount } = stats;
  const w = (s) => process.stderr.write(`${s}\n`);

  w(`opsec-scan: ${blobCount} blobs, ${msgCount} commit messages, ${stagedCount} staged files`);

  const fails = allIssues.filter((i) => i.severity === "fail");
  const warns = allIssues.filter((i) => i.severity === "warn");

  if (fails.length === 0 && warns.length === 0) {
    w("  ✓ no issues found");
    return 0;
  }

  const grouped = new Map();
  for (const i of [...fails, ...warns]) {
    const key = `[${i.severity.toUpperCase()}] ${i.check}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(i);
  }

  w("");
  for (const [key, items] of grouped) {
    w(`${key} (${items.length} hits):`);
    // Dedupe by location:line to avoid spamming repeated matches
    const seen = new Set();
    let printed = 0;
    for (const i of items) {
      const sig = `${i.location}:${i.line}:${i.match}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      if (printed >= 25) {
        w(`  ... and ${items.length - printed} more (${seen.size} unique)`);
        break;
      }
      w(`  ${i.location}:${i.line}  match=${JSON.stringify(i.match)}`);
      printed++;
    }
    w("");
  }

  w(`totals: ${fails.length} fail, ${warns.length} warn`);
  return fails.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------
// HEAD-only scan (current tree, no history walk)
// ---------------------------------------------------------------------------

function scanHead(checks) {
  const issues = [];
  let blobCount = 0;

  const tree = git(["ls-tree", "-r", "HEAD"]);
  for (const line of tree.split("\n")) {
    const m = line.match(/^\S+ blob (\S+)\s+(.+)$/);
    if (!m) continue;
    const [, sha, p] = m;
    if (p === SELF_PATH || SKIP_PATHS.has(p)) continue;

    issues.push(...scanText(p, checks, `${p} (path)`));

    let buf;
    try {
      buf = gitBuf(["cat-file", "blob", sha], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      continue;
    }
    if (buf.length > 2 * 1024 * 1024 || isBinary(buf)) continue;
    blobCount++;
    issues.push(...scanText(buf.toString("utf8"), checks, p));
  }

  // Also scan HEAD commit messages (just the latest, as a baseline check)
  const headMsg = git(["log", "-1", "--format=%B"]).trim();
  let msgCount = 0;
  if (headMsg) {
    msgCount = 1;
    issues.push(...scanText(headMsg, checks, "HEAD commit message"));
  }

  return { issues, blobCount, msgCount };
}

// ---------------------------------------------------------------------------
// Unpushed scan (commits between remote tracking branch and HEAD)
// ---------------------------------------------------------------------------

function getUnpushedRange() {
  // Try to find the upstream tracking branch. If none, fall back to
  // scanning all history (equivalent to first push).
  try {
    const upstream = execFileSync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    if (upstream) return `${upstream}..HEAD`;
  } catch {
    // No upstream configured — scan everything.
  }
  return null;
}

function scanUnpushed(checks) {
  const range = getUnpushedRange();
  const issues = [];
  let blobCount = 0;
  let msgCount = 0;

  // Determine which commits are unpushed.
  let commitList;
  if (range) {
    try {
      commitList = git(["rev-list", range]).trim().split("\n").filter(Boolean);
    } catch {
      commitList = [];
    }
  } else {
    // No upstream — all commits are unpushed.
    commitList = git(["rev-list", "--all"]).trim().split("\n").filter(Boolean);
  }

  if (commitList.length === 0) {
    // Nothing unpushed — just scan HEAD tree as a baseline.
    return scanHead(checks);
  }

  // Collect all unique blobs introduced in the unpushed commits.
  const blobsBySha = new Map();
  for (const commit of commitList) {
    let tree;
    try {
      tree = git(["ls-tree", "-r", commit]);
    } catch {
      continue;
    }
    for (const line of tree.split("\n")) {
      const m = line.match(/^\S+ blob (\S+)\s+(.+)$/);
      if (!m) continue;
      const [, sha, p] = m;
      if (!blobsBySha.has(sha)) blobsBySha.set(sha, new Set());
      blobsBySha.get(sha).add(p);
    }
  }

  for (const [sha, paths] of blobsBySha) {
    for (const p of paths) {
      if (p === SELF_PATH || SKIP_PATHS.has(p)) continue;
      issues.push(...scanText(p, checks, `${p} (path)`));
    }
    const shouldSkip = [...paths].every((p) => p === SELF_PATH || SKIP_PATHS.has(p));
    if (shouldSkip) continue;

    let buf;
    try {
      buf = gitBuf(["cat-file", "blob", sha], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      continue;
    }
    if (buf.length > 2 * 1024 * 1024 || isBinary(buf)) continue;
    blobCount++;
    const label = [...paths][0];
    issues.push(...scanText(buf.toString("utf8"), checks, label));
  }

  // Scan unpushed commit messages.
  for (const commit of commitList) {
    try {
      const body = git(["log", "-1", "--format=%B", commit]).trim();
      if (!body) continue;
      msgCount++;
      issues.push(...scanText(body, checks, `commit ${commit.slice(0, 8)}`));
    } catch {
      // skip unreadable commits
    }
  }

  return { issues, blobCount, msgCount };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const stagedOnly = process.argv.includes("--staged");
  const headOnly = process.argv.includes("--head");
  const unpushed = process.argv.includes("--unpushed");
  const { checks, projects, sessions } = buildChecks();
  process.stderr.write(
    `opsec-scan: ${projects.length} projects, ${sessions.length} session ids discovered\n`
  );

  let treeResult = { issues: [], blobCount: 0, msgCount: 0 };
  if (unpushed) {
    treeResult = scanUnpushed(checks);
  } else if (headOnly) {
    treeResult = scanHead(checks);
  } else if (!stagedOnly) {
    treeResult = scanHistory(checks);
  }
  const stagedResult = scanStaged(checks);

  const allIssues = [...treeResult.issues, ...stagedResult.issues];
  return report(allIssues, {
    blobCount: treeResult.blobCount,
    msgCount: treeResult.msgCount,
    stagedCount: stagedResult.count,
  });
}

try {
  process.exit(main());
} catch (err) {
  process.stderr.write(`opsec-scan: fatal: ${err.message}\n`);
  process.exit(2);
}
