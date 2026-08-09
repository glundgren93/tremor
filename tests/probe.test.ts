import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  deduplicateBaselineShots,
  observationFingerprint,
  type ProbeOutcome,
  probeOne,
  settleVisibleContent,
} from "../src/cli/probe";
import type { Driver } from "../src/driver/driver";
import type { ContentState } from "../src/observers/content";
import type { Scenario } from "../src/types/chaos";
import type { Observation } from "../src/types/observation";
import { ok } from "../src/types/result";

function observation(facts: Record<string, unknown>): Observation {
  return {
    id: "obs-1",
    kind: "content.sample",
    summary: "sample",
    facts,
    target: { selector: "#result", url: "https://app.test/" },
    evidence: [],
    observedAt: 1,
  };
}

function outcome(path: string | null): ProbeOutcome {
  return {
    scenario: { id: "s", name: "scenario", category: "error", endpoint: "GET /api" },
    appeared: [],
    disappeared: [],
    unchangedCount: 0,
    receipts: [],
    matchedCount: 0,
    appliedCount: 0,
    proof: { baselineShot: path, faultedShot: null, video: null },
    error: null,
  };
}

describe("deduplicateBaselineShots", () => {
  it("keeps one canonical file and rewrites identical references", () => {
    const dir = mkdtempSync(join(tmpdir(), "tremor-probe-"));
    try {
      const first = join(dir, "first.png");
      const second = join(dir, "second.png");
      writeFileSync(first, "same");
      writeFileSync(second, "same");
      const outcomes = [outcome(first), outcome(second)];

      deduplicateBaselineShots(outcomes);

      expect(outcomes[1]?.proof.baselineShot).toBe(first);
      expect(() => readFileSync(second)).toThrow();
      expect(readFileSync(first, "utf8")).toBe("same");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not unlink when duplicate outcomes already share a path", () => {
    const dir = mkdtempSync(join(tmpdir(), "tremor-probe-"));
    try {
      const first = join(dir, "first.png");
      writeFileSync(first, "same");
      const outcomes = [outcome(first), outcome(first)];
      deduplicateBaselineShots(outcomes);
      expect(readFileSync(first, "utf8")).toBe("same");
      expect(outcomes[1]?.proof.baselineShot).toBe(first);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not merge different or missing files", () => {
    const dir = mkdtempSync(join(tmpdir(), "tremor-probe-"));
    try {
      const first = join(dir, "first.png");
      const second = join(dir, "second.png");
      const missing = join(dir, "missing.png");
      writeFileSync(first, "one");
      writeFileSync(second, "two");
      const outcomes = [outcome(first), outcome(second), outcome(missing)];

      deduplicateBaselineShots(outcomes);

      expect(outcomes.map((item) => item.proof.baselineShot)).toEqual([first, second, missing]);
      expect(readFileSync(second, "utf8")).toBe("two");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const fakeDriver = {} as Driver;

function content(overrides: Partial<ContentState> = {}): ContentState {
  return {
    visibleTextLength: 20,
    textSample: "Ready",
    elementCount: 4,
    headings: ["Ready"],
    errorPhrases: [],
    spinnerCount: 0,
    imageCount: 0,
    linkCount: 0,
    title: "App",
    ...overrides,
  };
}

describe("settleVisibleContent", () => {
  it("requires a stable window and waits through transitional text", async () => {
    let clock = 0;
    let calls = 0;
    const states = [
      content({ textSample: "Loading..." }),
      content({ textSample: "Ready" }),
      content({ textSample: "Ready" }),
      content({ textSample: "Ready" }),
      content({ textSample: "Ready" }),
      content({ textSample: "Ready" }),
    ];
    await settleVisibleContent(fakeDriver, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      sampleMs: 120,
      stableMs: 750,
      maxMs: 3_000,
      sample: async () => ok(states[Math.min(calls++, states.length - 1)] ?? content()),
    });
    expect(clock).toBeGreaterThanOrEqual(750);
    expect(calls).toBeGreaterThan(2);
  });

  it("waits through constant transitional text until the deadline", async () => {
    let clock = 0;
    await settleVisibleContent(fakeDriver, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      sample: async () => ok(content({ textSample: "Authenticating..." })),
      maxMs: 1_000,
    });
    expect(clock).toBe(1_000);
  });

  it("settles a ready state only after the stable window", async () => {
    let clock = 0;
    await settleVisibleContent(fakeDriver, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      sample: async () => ok(content()),
      sampleMs: 120,
      stableMs: 750,
      maxMs: 3_000,
    });
    expect(clock).toBeGreaterThanOrEqual(750);
    expect(clock).toBeLessThan(3_000);
  });

  it("does not settle after only two samples and exits at the deadline", async () => {
    let clock = 0;
    let calls = 0;
    await settleVisibleContent(fakeDriver, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      sample: async () => {
        calls++;
        return ok(content({ textSample: `Changing ${calls}` }));
      },
      maxMs: 3_000,
    });
    expect(clock).toBe(3_000);
    expect(calls).toBeGreaterThan(10);
  });
});

const scenario: Scenario = {
  id: "scenario-1",
  name: "GET /api → Service Unavailable",
  description: "test",
  category: "error",
  priority: 1,
  endpoint: { method: "GET", pattern: "https://app.test/api" },
  endpointType: "api",
};

function probeOptions() {
  return {
    url: "https://app.test/",
    runDir: "/tmp/tremor-probe-run",
    headless: true,
    waitUntil: "load" as const,
    timeoutMs: 1_000,
    viewport: { width: 800, height: 600 },
    video: false,
  };
}

function lifecycleDriver(
  reloadError = false,
  events: string[] = [],
  currentUrl = "https://app.test/",
): Driver & { screenshots: string[]; phase: string; markFinal(): void } {
  const state = { phase: "baseline", final: false, screenshots: [] as string[] };
  return {
    backend: "playwright",
    screenshots: state.screenshots,
    get phase() {
      return state.phase;
    },
    markFinal() {
      state.final = true;
    },
    navigate: async () => ok({ url: "https://app.test/", status: 200, durationMs: 1 }),
    reload: async () => {
      state.phase = "faulted";
      return reloadError
        ? { ok: false, error: new Error("reload failed") }
        : ok({ url: "https://app.test/", status: 503, durationMs: 1 });
    },
    waitForIdle: async () => ok(undefined),
    currentUrl: () => currentUrl,
    evaluate: async () => ok(undefined as never),
    screenshot: async ({ label }) => {
      const visibleState = state.final ? "final" : state.phase;
      state.screenshots.push(`${label}:${visibleState}`);
      events.push(`screenshot:${label}:${visibleState}`);
      return ok({
        kind: "screenshot" as const,
        path: `/tmp/${label}-${visibleState}.png`,
        label,
        capturedAt: 1,
      });
    },
    intercept: async () => ok({ dispose: async () => undefined }),
    clearIntercepts: async () => ok(undefined),
    emulateNetwork: async () => ok(undefined),
    emulateCpuThrottle: async () => ok(undefined),
    setViewport: async () => ok(undefined),
    startRecording: async () => ok(undefined),
    stopRecording: async () => ok(undefined),
    drainExchanges: () => [],
    drainFaultReceipts: () => [],
    drainConsole: () => ({ kind: "console" as const, entries: [] }),
    recordingPath: async () => null,
    close: async () => undefined,
  };
}

describe("probe screenshot lifecycle", () => {
  it("captures faulted-final after post-fault observation and content", async () => {
    const events: string[] = [];
    const driver = lifecycleDriver(false, events);
    const result = await probeOne(probeOptions(), scenario, 0, "proof", driver, {
      settle: async () => {
        events.push(`settle:${driver.phase}`);
      },
      observe: async () => {
        events.push(`observe:${driver.phase}`);
        return [];
      },
      content: async () => {
        events.push(`content:${driver.phase}`);
        if (driver.phase === "faulted") driver.markFinal();
        return ok(content());
      },
    });
    expect(events).toEqual([
      "settle:baseline",
      "content:baseline",
      "observe:baseline",
      "screenshot:baseline:baseline",
      "settle:faulted",
      "observe:faulted",
      "content:faulted",
      "screenshot:faulted-final:final",
    ]);
    expect(driver.screenshots.at(-1)).toBe("faulted-final:final");
    expect(result.proof.faultedShot).toBe("/tmp/faulted-final-final.png");
  });

  it("captures best-effort faulted-final when reload fails", async () => {
    const driver = lifecycleDriver(true);
    const result = await probeOne(probeOptions(), scenario, 0, "proof", driver, {
      settle: async () => undefined,
      observe: async () => [],
      content: async () => ok(content()),
    });
    expect(result.error).toContain("reload failed");
    expect(result.proof.faultedShot).toBe("/tmp/faulted-final-faulted.png");
  });

  it("fails cleanly on an expired authenticated baseline without interception or screenshots", async () => {
    const events: string[] = [];
    const driver = lifecycleDriver(
      false,
      events,
      "https://login.example.test/login?code=sentinel-code&state=sentinel-state",
    );
    let intercepted = 0;
    driver.intercept = async () => {
      intercepted++;
      return ok({ dispose: async () => undefined });
    };
    const result = await probeOne(
      { ...probeOptions(), authSelection: { kind: "profile", name: "staging" } },
      scenario,
      0,
      "proof",
      driver,
      {
        settle: async () => events.push("settle"),
        observe: async () => {
          events.push("observe");
          return [];
        },
        content: async () => ok(content()),
      },
    );
    expect(result.failureKind).toBe("authentication");
    expect(result.error).toContain('profile "staging"');
    expect(result.error).not.toContain("sentinel");
    expect(intercepted).toBe(0);
    expect(driver.screenshots).toEqual([]);
    expect(events).toEqual([]);
  });

  it("does not settle or screenshot in smoke mode", async () => {
    const driver = lifecycleDriver();
    let settles = 0;
    await probeOne(probeOptions(), scenario, 0, "smoke", driver, {
      settle: async () => {
        settles++;
      },
      content: async () => ok(content()),
    });
    expect(settles).toBe(0);
    expect(driver.screenshots).toEqual([]);
  });
});

describe("observationFingerprint", () => {
  it("normalizes volatile timestamps, UUIDs, counters, whitespace, and key order", () => {
    const first = observation({
      text: "Updated 2026-08-08T18:00:00.000Z   run 123456",
      requestId: "123e4567-e89b-12d3-a456-426614174000",
      nested: { b: 2, a: 1 },
    });
    const second = observation({
      nested: { a: 1, b: 2 },
      requestId: "987e6543-e21b-12d3-a456-426614174999",
      text: "Updated 2027-09-09T19:01:02Z run 987654321",
    });

    expect(observationFingerprint(first)).toBe(observationFingerprint(second));
  });

  it("detects meaningful fact changes on the same kind and selector", () => {
    expect(observationFingerprint(observation({ clippedByPx: 20 }))).not.toBe(
      observationFingerprint(observation({ clippedByPx: 240 })),
    );
  });
});
