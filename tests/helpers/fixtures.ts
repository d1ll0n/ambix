import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * Write JSONL text to a temp file and return the path.
 * Caller passes the parent dir created via `makeTempDir` so
 * cleanup is centralized.
 */
export function writeFixture(parentDir: string, name: string, text: string): string {
  const filePath = path.join(parentDir, name);
  writeFileSync(filePath, text);
  return filePath;
}

export function makeTempDir(prefix = "alembic-test-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

export function cleanupTempDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

let counter = 0;
function nextId(): string {
  counter++;
  return `00000000-0000-0000-0000-${counter.toString().padStart(12, "0")}`;
}

export function userLine(opts: {
  text?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  ts?: string;
  cwd?: string;
  gitBranch?: string;
  version?: string;
}): string {
  const {
    text = "hello",
    uuid = nextId(),
    parentUuid = null,
    sessionId = "session-test",
    ts = "2026-04-13T00:00:00Z",
    cwd = "/work",
    gitBranch = "main",
    version = "2.1.97",
  } = opts;
  return JSON.stringify({
    type: "user",
    uuid,
    parentUuid,
    sessionId,
    timestamp: ts,
    cwd,
    gitBranch,
    version,
    message: { role: "user", content: text },
  });
}

export function assistantLine(opts: {
  text?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  ts?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  contentBlocks?: unknown[];
  requestId?: string;
}): string {
  const {
    text = "ok",
    uuid = nextId(),
    parentUuid = null,
    sessionId = "session-test",
    ts = "2026-04-13T00:00:00Z",
    model = "claude-sonnet-4-6",
    inputTokens = 10,
    outputTokens = 5,
    cacheReadTokens = 0,
    contentBlocks,
    requestId = `req_${counter}`,
  } = opts;
  return JSON.stringify({
    type: "assistant",
    uuid,
    parentUuid,
    sessionId,
    timestamp: ts,
    requestId,
    message: {
      role: "assistant",
      id: `msg_${counter}`,
      model,
      content: contentBlocks ?? [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_input_tokens: cacheReadTokens,
      },
    },
  });
}

export function joinLines(...lines: string[]): string {
  return lines.join("\n") + "\n";
}
