import { describe, expect, it } from "vitest";
import type { Finding } from "../src/core/types";
import { adjustedSeverity, calculateScore } from "../src/dashboard/scoring";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "test-1",
    scenarioName: "test scenario",
    severity: "good",
    description: "test",
    screenshotPath: null,
    endpoint: "/api/test",
    category: "error",
    metrics: null,
    timestamp: Date.now(),
    endpointType: "api",
    testType: "initial-load",
    ...overrides,
  };
}

describe("adjustedSeverity", () => {
  it("returns original severity when not 'good'", () => {
    expect(adjustedSeverity(makeFinding({ severity: "critical" }))).toBe("critical");
    expect(adjustedSeverity(makeFinding({ severity: "major" }))).toBe("major");
    expect(adjustedSeverity(makeFinding({ severity: "minor" }))).toBe("minor");
  });

  it("returns 'good' when no metrics are present", () => {
    expect(adjustedSeverity(makeFinding({ severity: "good", metrics: null }))).toBe("good");
  });

  it("returns 'good' when all metrics are good", () => {
    const finding = makeFinding({
      severity: "good",
      metrics: { lcp: 1000, cls: 0.05, ttfb: 200, inp: 100 },
    });
    expect(adjustedSeverity(finding)).toBe("good");
  });

  it("returns 'good' when all metrics are null", () => {
    const finding = makeFinding({
      severity: "good",
      metrics: { lcp: null, cls: null, ttfb: null, inp: null },
    });
    expect(adjustedSeverity(finding)).toBe("good");
  });

  it("downgrades to 'minor' when any metric is poor", () => {
    const finding = makeFinding({
      severity: "good",
      metrics: { lcp: 5000, cls: 0.05, ttfb: 200, inp: 100 },
    });
    expect(adjustedSeverity(finding)).toBe("minor");
  });

  it("downgrades to 'minor' when any metric is needs-improvement", () => {
    const finding = makeFinding({
      severity: "good",
      metrics: { lcp: 3000, cls: 0.05, ttfb: 200, inp: 100 },
    });
    expect(adjustedSeverity(finding)).toBe("minor");
  });

  it("downgrades to 'minor' when INP is poor", () => {
    const finding = makeFinding({
      severity: "good",
      metrics: { lcp: 1000, cls: 0.05, ttfb: 200, inp: 600 },
    });
    expect(adjustedSeverity(finding)).toBe("minor");
  });
});

describe("calculateScore with metric adjustment", () => {
  it("returns 100 for no findings", () => {
    expect(calculateScore([])).toBe(100);
  });

  it("returns 100 for good findings with good metrics", () => {
    const findings = [
      makeFinding({ severity: "good", metrics: { lcp: 1000, cls: 0.05, ttfb: 200, inp: 100 } }),
    ];
    expect(calculateScore(findings)).toBe(100);
  });

  it("downgrades score when good finding has poor metrics", () => {
    const findings = [
      makeFinding({ severity: "good", metrics: { lcp: 5000, cls: 0.05, ttfb: 200, inp: 100 } }),
    ];
    // adjustedSeverity → "minor" → weight 70
    expect(calculateScore(findings)).toBe(70);
  });

  it("does not affect non-good severity findings", () => {
    const findings = [
      makeFinding({ severity: "critical", metrics: { lcp: 5000, cls: 0.3, ttfb: 2000, inp: 600 } }),
    ];
    // critical weight is 0 regardless of metrics
    expect(calculateScore(findings)).toBe(0);
  });

  it("excludes document findings from score", () => {
    const findings = [
      makeFinding({ severity: "critical", endpointType: "document" }),
      makeFinding({
        id: "test-2",
        severity: "good",
        metrics: { lcp: 1000, cls: 0.05, ttfb: 200, inp: 100 },
      }),
    ];
    // Only the "good" API finding counts → 100
    expect(calculateScore(findings)).toBe(100);
  });
});
