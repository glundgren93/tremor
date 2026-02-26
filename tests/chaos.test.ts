import { describe, expect, it, vi } from "vitest";
import { calculateLatency, corruptBody, shouldFire } from "../src/core/chaos";

describe("calculateLatency", () => {
  it("returns fixed ms", () => {
    expect(calculateLatency({ type: "latency", ms: 500, distribution: "fixed" })).toBe(500);
  });

  it("returns uniform value between 0 and ms", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const result = calculateLatency({ type: "latency", ms: 1000, distribution: "uniform" });
    expect(result).toBe(500);
    vi.restoreAllMocks();
  });

  it("returns normal-distributed value", () => {
    const result = calculateLatency({ type: "latency", ms: 1000, distribution: "normal" });
    expect(result).toBeGreaterThanOrEqual(0);
  });
});

describe("shouldFire", () => {
  it("fires at rate 1.0", () => {
    expect(shouldFire(1.0)).toBe(true);
  });

  it("does not fire at rate 0", () => {
    expect(shouldFire(0)).toBe(false);
  });

  it("fires probabilistically", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.3);
    expect(shouldFire(0.5)).toBe(true);
    expect(shouldFire(0.2)).toBe(false);
    vi.restoreAllMocks();
  });
});

describe("corruptBody", () => {
  it("removes a field", () => {
    const body = JSON.stringify({ name: "Alice", age: 30 });
    const result = corruptBody(body, [{ field: "name", action: "remove" }]);
    expect(JSON.parse(result)).toEqual({ age: 30 });
  });

  it("nullifies a field", () => {
    const body = JSON.stringify({ name: "Alice" });
    const result = corruptBody(body, [{ field: "name", action: "nullify" }]);
    expect(JSON.parse(result)).toEqual({ name: null });
  });

  it("empties a string field", () => {
    const body = JSON.stringify({ name: "Alice" });
    const result = corruptBody(body, [{ field: "name", action: "empty" }]);
    expect(JSON.parse(result)).toEqual({ name: "" });
  });

  it("empties an array field", () => {
    const body = JSON.stringify({ items: [1, 2, 3] });
    const result = corruptBody(body, [{ field: "items", action: "empty" }]);
    expect(JSON.parse(result)).toEqual({ items: [] });
  });

  it("replaces a field", () => {
    const body = JSON.stringify({ name: "Alice" });
    const result = corruptBody(body, [{ field: "name", action: "replace", value: "CORRUPTED" }]);
    expect(JSON.parse(result)).toEqual({ name: "CORRUPTED" });
  });

  it("handles nested fields", () => {
    const body = JSON.stringify({ user: { name: "Alice" } });
    const result = corruptBody(body, [{ field: "user.name", action: "nullify" }]);
    expect(JSON.parse(result)).toEqual({ user: { name: null } });
  });

  it("returns original body on invalid JSON", () => {
    expect(corruptBody("not json", [{ field: "x", action: "remove" }])).toBe("not json");
  });
});
