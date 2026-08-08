import { describe, expect, it } from "vitest";
import { err, ok, tryCatch, unwrap } from "../src/types/result";

describe("ok", () => {
  it("creates a success result", () => {
    const result = ok(42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it("works with string values", () => {
    const result = ok("hello");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe("hello");
  });

  it("works with null", () => {
    const result = ok(null);
    expect(result).toEqual({ ok: true, value: null });
  });
});

describe("err", () => {
  it("creates a failure result", () => {
    const error = new Error("fail");
    const result = err(error);
    expect(result).toEqual({ ok: false, error });
  });

  it("works with string errors", () => {
    const result = err("something broke");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("something broke");
  });
});

describe("tryCatch", () => {
  it("returns ok for successful async function", async () => {
    const result = await tryCatch(async () => 42);
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it("returns err when async function throws Error", async () => {
    const result = await tryCatch(async () => {
      throw new Error("boom");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("boom");
  });

  it("wraps non-Error throws into Error", async () => {
    const result = await tryCatch(async () => {
      throw "string error";
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(Error);
      expect(result.error.message).toBe("string error");
    }
  });

  it("handles rejected promises", async () => {
    const result = await tryCatch(() => Promise.reject(new Error("rejected")));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toBe("rejected");
  });
});

describe("unwrap", () => {
  it("returns value for ok result", () => {
    expect(unwrap(ok(42))).toBe(42);
  });

  it("throws for err result", () => {
    expect(() => unwrap(err(new Error("fail")))).toThrow("fail");
  });
});
