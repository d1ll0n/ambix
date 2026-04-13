import { describe, it, expect } from "vitest";
import { makePreview } from "../../src/stage/preview.js";

describe("makePreview", () => {
  it("returns short strings unchanged", () => {
    expect(makePreview("hello", 100)).toBe("hello");
  });

  it("truncates long strings to maxChars and appends an ellipsis marker", () => {
    const long = "x".repeat(1000);
    const result = makePreview(long, 50);
    expect(result.length).toBeLessThanOrEqual(50 + " …[truncated]".length);
    expect(result.endsWith("…[truncated]")).toBe(true);
  });

  it("stringifies objects deterministically before truncating", () => {
    const obj = { b: 2, a: 1 };
    const result = makePreview(obj, 100);
    // keys sorted for determinism
    expect(result).toBe('{"a":1,"b":2}');
  });

  it("handles nested objects", () => {
    const obj = { outer: { inner: "value" } };
    const result = makePreview(obj, 100);
    expect(result).toBe('{"outer":{"inner":"value"}}');
  });

  it("returns empty string for null/undefined", () => {
    expect(makePreview(null, 100)).toBe("");
    expect(makePreview(undefined, 100)).toBe("");
  });
});
