import { describe, expect, it } from "vitest";
import {
  type TruncateStats,
  truncateOversizedStrings,
} from "../../src/compact-session/truncate.js";

function emptyStats(): TruncateStats {
  return { truncatedFieldCount: 0, bytesSaved: 0 };
}

const OPTS = { maxFieldBytes: 20, marker: "[TRUNC]" };

describe("truncateOversizedStrings", () => {
  it("replaces strings over the threshold and counts them in stats", () => {
    const stats = emptyStats();
    const result = truncateOversizedStrings({ big: "x".repeat(100) }, OPTS, stats);
    expect(result).toEqual({ big: "[TRUNC]" });
    expect(stats.truncatedFieldCount).toBe(1);
    expect(stats.bytesSaved).toBe(100 - "[TRUNC]".length);
  });

  it("leaves strings at or below threshold alone", () => {
    const stats = emptyStats();
    const result = truncateOversizedStrings({ small: "ok" }, OPTS, stats);
    expect(result).toEqual({ small: "ok" });
    expect(stats.truncatedFieldCount).toBe(0);
    expect(stats.bytesSaved).toBe(0);
  });

  it("walks nested objects and arrays", () => {
    const stats = emptyStats();
    const result = truncateOversizedStrings(
      {
        top: "ok",
        nested: { a: "x".repeat(30), b: [{ c: "y".repeat(50) }, "tiny"] },
      },
      OPTS,
      stats
    );
    expect(result).toEqual({
      top: "ok",
      nested: { a: "[TRUNC]", b: [{ c: "[TRUNC]" }, "tiny"] },
    });
    expect(stats.truncatedFieldCount).toBe(2);
  });

  it("leaves non-string scalars untouched", () => {
    const stats = emptyStats();
    const result = truncateOversizedStrings(
      { n: 42, b: true, z: null, bigStr: "x".repeat(30) },
      OPTS,
      stats
    );
    expect(result).toEqual({ n: 42, b: true, z: null, bigStr: "[TRUNC]" });
    expect(stats.truncatedFieldCount).toBe(1);
  });

  it("measures UTF-8 bytes, not JS char count", () => {
    const stats = emptyStats();
    // 3-byte char × 10 = 30 bytes, above threshold of 20
    const result = truncateOversizedStrings("€".repeat(10), OPTS, stats);
    expect(result).toBe("[TRUNC]");
    expect(stats.bytesSaved).toBe(30 - "[TRUNC]".length);
  });

  it("handles primitive value at the root", () => {
    const stats = emptyStats();
    expect(truncateOversizedStrings("short", OPTS, stats)).toBe("short");
    expect(truncateOversizedStrings("x".repeat(50), OPTS, stats)).toBe("[TRUNC]");
  });
});
