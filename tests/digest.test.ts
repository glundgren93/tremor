import { describe, expect, it } from "vitest";
import { compactObservation, digestChaos, digestScan } from "../src/cli/digest";
import type { ProbeOutcome } from "../src/cli/probe";
import type { Endpoint, Scenario } from "../src/types/chaos";
import { createObservation, type Observation } from "../src/types/observation";

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    method: "GET",
    pattern: "https://app.test/api/users",
    sampleUrl: "https://app.test/api/users",
    sampleResponse: { status: 200, headers: {}, body: "x".repeat(50_000) },
    hitCount: 1,
    endpointType: "api",
    firstParty: true,
    ...overrides,
  };
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "s",
    name: "GET /api/users → Server Error",
    description: "",
    category: "error",
    priority: 1,
    endpoint: { method: "GET", pattern: "https://app.test/api/users" },
    endpointType: "api",
    ...overrides,
  };
}

function obs(kind: string, selector: string | null, facts = {}): Observation {
  return createObservation({
    kind,
    summary: `${kind} on ${selector}`,
    facts,
    target: { selector, url: "https://app.test/" },
  });
}

describe("digestScan", () => {
  it("never leaks captured response bodies into stdout", () => {
    const d = digestScan([endpoint()], [scenario()], 1);
    expect(JSON.stringify(d)).not.toContain("xxxxx");
  });

  it("counts every scenario even though it only lists a few", () => {
    const many = Array.from({ length: 500 }, (_, i) => scenario({ id: `s${i}` }));
    const d = digestScan([endpoint()], many, 1);
    expect(d.scenarios.total).toBe(500);
    expect(d.scenarios.byCategory.error).toBe(500);
    expect(d.topScenarios.length).toBeLessThanOrEqual(10);
  });

  it("puts first-party endpoints ahead of busier third parties", () => {
    const d = digestScan(
      [
        endpoint({ pattern: "https://ads.example/bid", firstParty: false, hitCount: 99 }),
        endpoint({ pattern: "https://app.test/api/me", firstParty: true, hitCount: 1 }),
      ],
      [],
      2,
    );
    expect(d.topEndpoints[0]).toContain("app.test/api/me");
  });
});

describe("compactObservation", () => {
  it("drops heavy facts but keeps judgement-relevant ones", () => {
    const c = compactObservation(
      obs("layout.clipped-content", "div.card", {
        rect: { x: 0, y: 0, width: 10, height: 10 },
        clippedByPx: 200,
      }),
    );
    expect(c.facts.rect).toBeUndefined();
    expect(c.facts.clippedByPx).toBe(200);
  });

  it("truncates long strings", () => {
    const c = compactObservation(obs("k", "s", { textSample: "a".repeat(500) }));
    expect(String(c.facts.textSample).length).toBeLessThan(100);
  });

  it("flattens evidence to paths", () => {
    const o = obs("k", "s");
    o.evidence.push({ kind: "screenshot", path: "/tmp/a.png", label: "a", capturedAt: 0 });
    o.evidence.push({ kind: "console", entries: [] });
    expect(compactObservation(o).evidence).toEqual(["/tmp/a.png"]);
  });
});

describe("digestChaos", () => {
  function outcome(over: Partial<ProbeOutcome> = {}): ProbeOutcome {
    return {
      scenario: { id: "s", name: "GET /api → 500", category: "error", endpoint: "GET /api" },
      appeared: [],
      disappeared: [],
      unchangedCount: 12,
      proof: { baselineShot: "/tmp/b.png", faultedShot: "/tmp/f.png", video: "/tmp/v.webm" },
      error: null,
      ...over,
    };
  }

  const run = (outcomes: ProbeOutcome[]) =>
    digestChaos({ outcomes, scanned: { endpoints: 3, scenarios: 20 } });

  it("details scenarios that changed something", () => {
    const d = run([outcome({ appeared: [obs("content.text-lost", "body")] })]);
    expect(d.changed).toHaveLength(1);
    expect(d.changed[0]?.appeared[0]?.kind).toBe("content.text-lost");
    expect(d.unchanged).toHaveLength(0);
  });

  it("names scenarios that changed nothing without describing them", () => {
    const d = run([outcome()]);
    expect(d.changed).toHaveLength(0);
    expect(d.unchanged).toEqual(["GET /api → 500"]);
    // Cost control: a no-op scenario must not spend tokens on its observations.
    expect(JSON.stringify(d)).not.toContain("unchangedCount");
  });

  it("separates scenarios that could not be evaluated", () => {
    const d = run([outcome({ error: "page did not load under fault: timeout" })]);
    expect(d.failed).toHaveLength(1);
    expect(d.changed).toHaveLength(0);
    expect(d.unchanged).toHaveLength(0);
  });

  it("classifies receipt errors as failed even when observations changed", () => {
    const d = run([
      outcome({
        error: "page did not load under fault",
        appeared: [obs("content.text-lost", "body")],
      }),
    ]);
    expect(d.failed).toHaveLength(1);
    expect(d.changed).toHaveLength(0);
  });

  it("carries the before/after pair and video for every changed scenario", () => {
    const d = run([outcome({ appeared: [obs("content.text-lost", "body")] })]);
    expect(d.changed[0]?.proof).toEqual({
      baseline: "/tmp/b.png",
      faulted: "/tmp/f.png",
      video: "/tmp/v.webm",
    });
  });

  it("reports how much was scanned versus probed", () => {
    const d = run([outcome(), outcome()]);
    expect(d.scanned).toEqual({ endpoints: 3, scenarios: 20 });
    expect(d.probed).toBe(2);
  });
});
