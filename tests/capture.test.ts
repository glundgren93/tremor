import { describe, expect, it } from "vitest";
import { scan, toCapturedRequests } from "../src/capture/capture";
import type { Driver, RecordedExchange } from "../src/driver/driver";
import { ok } from "../src/types/result";

function exchange(overrides: Partial<RecordedExchange> = {}): RecordedExchange {
  return {
    id: "x1",
    timestamp: 1000,
    method: "GET",
    url: "https://app.test/api/users/123",
    resourceType: "xhr",
    requestHeaders: {},
    requestBody: null,
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: '{"name":"ada"}',
      durationMs: 42,
    },
    ...overrides,
  };
}

function fakeDriver(exchanges: RecordedExchange[], overrides: Partial<Driver> = {}): Driver {
  let drained = false;
  return {
    backend: "playwright",
    navigate: async () => ok({ url: "https://app.test/", status: 200, durationMs: 10 }),
    reload: async () => ok({ url: "https://app.test/", status: 200, durationMs: 10 }),
    waitForIdle: async () => ok(undefined),
    currentUrl: () => "https://app.test/",
    evaluate: async () => ok(undefined as never),
    screenshot: async () =>
      ok({ kind: "screenshot", path: "/tmp/x.png", label: "x", capturedAt: 0 }),
    intercept: async () => ok({ dispose: async () => {} }),
    clearIntercepts: async () => ok(undefined),
    emulateNetwork: async () => ok(undefined),
    emulateCpuThrottle: async () => ok(undefined),
    setViewport: async () => ok(undefined),
    startRecording: async () => ok(undefined),
    stopRecording: async () => ok(undefined),
    drainExchanges: () => {
      if (drained) return [];
      drained = true;
      return exchanges;
    },
    drainFaultReceipts: () => [],
    drainConsole: () => ({ kind: "console", entries: [] }),
    recordingPath: async () => null,
    close: async () => {},
    ...overrides,
  };
}

describe("toCapturedRequests", () => {
  it("drops exchanges that never got a response", () => {
    expect(toCapturedRequests([exchange({ response: null })])).toHaveLength(0);
  });

  it("drops non-standard HTTP methods rather than mistyping them", () => {
    expect(toCapturedRequests([exchange({ method: "PROPFIND" })])).toHaveLength(0);
  });

  it("normalises lowercase methods", () => {
    const [first] = toCapturedRequests([exchange({ method: "post" })]);
    expect(first?.method).toBe("POST");
  });

  it("carries the response body through for corruption seeding", () => {
    const [first] = toCapturedRequests([exchange()]);
    expect(first?.response.body).toBe('{"name":"ada"}');
    expect(first?.response.duration).toBe(42);
  });
});

describe("scan", () => {
  it("collapses id segments and generates scenarios from real traffic", async () => {
    const driver = fakeDriver([
      exchange({ id: "a", url: "https://app.test/api/users/123" }),
      exchange({ id: "b", url: "https://app.test/api/users/456", timestamp: 2000 }),
    ]);

    const result = await scan(driver, { url: "https://app.test/" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.value.endpoints).toHaveLength(1);
    expect(result.value.endpoints[0]?.pattern).toBe("https://app.test/api/users/*");
    expect(result.value.endpoints[0]?.hitCount).toBe(2);
    expect(result.value.scenarios.length).toBeGreaterThan(0);
    expect(result.value.exchangeCount).toBe(2);
  });

  it("applies the path filter before building scenarios", async () => {
    const driver = fakeDriver([
      exchange({ id: "a", url: "https://app.test/api/users" }),
      exchange({ id: "b", url: "https://app.test/api/orders" }),
    ]);

    const result = await scan(driver, { url: "https://app.test/", filter: "orders" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endpoints.map((e) => e.pattern)).toEqual(["https://app.test/api/orders"]);
  });

  it("propagates navigation failure instead of returning an empty scan", async () => {
    const driver = fakeDriver([exchange()], {
      navigate: async () => ({ ok: false, error: new Error("net::ERR_FAILED") }),
    });

    const result = await scan(driver, { url: "https://app.test/" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("ERR_FAILED");
  });

  it("succeeds with no scenarios when the page made no qualifying requests", async () => {
    const result = await scan(fakeDriver([]), { url: "https://app.test/" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.endpoints).toEqual([]);
    expect(result.value.scenarios).toEqual([]);
  });
});
