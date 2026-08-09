import { describe, expect, it, vi } from "vitest";
import {
  calculateLatency,
  corruptBody,
  decideEffects,
  MAX_TRANSPORT_DELAY_MS,
  shouldFire,
} from "../src/chaos/effects";

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

  it("clamps every distribution to the hard 3000ms cap", () => {
    expect(calculateLatency({ type: "latency", ms: 9000, distribution: "fixed" })).toBe(3000);
    expect(calculateLatency({ type: "latency", ms: 9000, distribution: "uniform" }, () => 1)).toBe(
      3000,
    );
    expect(
      calculateLatency({ type: "latency", ms: 9000, distribution: "normal" }, () => Number.EPSILON),
    ).toBe(3000);
  });

  it("fails closed for negative and non-finite latency inputs", () => {
    expect(calculateLatency({ type: "latency", ms: -1, distribution: "fixed" })).toBe(0);
    expect(calculateLatency({ type: "latency", ms: Number.NaN, distribution: "fixed" })).toBe(0);
    expect(
      calculateLatency({ type: "latency", ms: Number.POSITIVE_INFINITY, distribution: "fixed" }),
    ).toBe(0);
    expect(
      calculateLatency({ type: "latency", ms: 1000, distribution: "uniform" }, () => Number.NaN),
    ).toBe(0);
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

describe("decideEffects", () => {
  it("returns the actual delay immediately without sleeping", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        decideEffects([{ type: "latency", ms: 1000, distribution: "fixed" }]),
      ).resolves.toEqual({ action: "delay", ms: 1000, delayKind: "latency" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not apply the latency cap to throttle delay", async () => {
    await expect(decideEffects([{ type: "throttle", bytesPerSecond: 10_000 }])).resolves.toEqual({
      action: "delay",
      ms: 5000,
      delayKind: "throttle",
    });
  });

  it("carries latency before a terminal error without sleeping", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        decideEffects(
          [
            { type: "latency", ms: 750, distribution: "fixed" },
            { type: "error", status: 502, rate: 1 },
          ],
          () => 0,
        ),
      ).resolves.toMatchObject({
        action: "fulfill",
        status: 502,
        preDelayMs: 750,
        delayKind: "latency",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("carries throttle before a terminal error with truthful metadata", async () => {
    await expect(
      decideEffects(
        [
          { type: "throttle", bytesPerSecond: 50_000 },
          { type: "error", status: 503, rate: 1 },
        ],
        () => 0,
      ),
    ).resolves.toMatchObject({
      action: "fulfill",
      status: 503,
      preDelayMs: 1000,
      delayKind: "throttle",
    });
  });

  it("caps throttle and summed transport waits and rejects invalid throttle math", async () => {
    await expect(decideEffects([{ type: "throttle", bytesPerSecond: 0 }])).resolves.toEqual({
      action: "continue",
    });
    const decision = await decideEffects([
      { type: "latency", ms: 3000, distribution: "fixed" },
      { type: "throttle", bytesPerSecond: 1 },
    ]);
    expect(decision).toMatchObject({
      action: "delay",
      ms: MAX_TRANSPORT_DELAY_MS,
      delayKind: "mixed",
    });
  });

  it("moves bounded timeout waiting into decision metadata", async () => {
    vi.useFakeTimers();
    try {
      await expect(
        decideEffects([{ type: "timeout", rate: 1, afterMs: Number.POSITIVE_INFINITY }], () => 0),
      ).resolves.toEqual({ action: "abort", reason: "timedout" });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
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
