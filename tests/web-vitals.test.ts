import { describe, expect, it } from "vitest";
import type { WebVitalsMetrics } from "../src/core/types";
import { formatMetrics, rateMetrics } from "../src/core/web-vitals";

describe("formatMetrics", () => {
  it("formats all metrics when present", () => {
    const metrics: WebVitalsMetrics = { lcp: 1234.56, cls: 0.0423, ttfb: 89.2, inp: 150 };
    expect(formatMetrics(metrics)).toBe("LCP: 1235ms | CLS: 0.042 | TTFB: 89ms | INP: 150ms");
  });

  it("shows N/A for null metrics", () => {
    const metrics: WebVitalsMetrics = { lcp: null, cls: null, ttfb: null, inp: null };
    expect(formatMetrics(metrics)).toBe("LCP: N/A | CLS: N/A | TTFB: N/A | INP: N/A");
  });

  it("handles mixed null and present values", () => {
    const metrics: WebVitalsMetrics = { lcp: 2500, cls: null, ttfb: 100, inp: null };
    expect(formatMetrics(metrics)).toBe("LCP: 2500ms | CLS: N/A | TTFB: 100ms | INP: N/A");
  });

  it("rounds LCP and TTFB to integers", () => {
    const metrics: WebVitalsMetrics = { lcp: 1000.7, cls: 0.1, ttfb: 50.4, inp: 99.9 };
    expect(formatMetrics(metrics)).toBe("LCP: 1001ms | CLS: 0.100 | TTFB: 50ms | INP: 100ms");
  });

  it("formats CLS to 3 decimal places", () => {
    const metrics: WebVitalsMetrics = { lcp: null, cls: 0.1, ttfb: null, inp: null };
    expect(formatMetrics(metrics)).toBe("LCP: N/A | CLS: 0.100 | TTFB: N/A | INP: N/A");
  });

  it("formats zero values correctly", () => {
    const metrics: WebVitalsMetrics = { lcp: 0, cls: 0, ttfb: 0, inp: 0 };
    expect(formatMetrics(metrics)).toBe("LCP: 0ms | CLS: 0.000 | TTFB: 0ms | INP: 0ms");
  });

  it("formats INP value when present", () => {
    const metrics: WebVitalsMetrics = { lcp: null, cls: null, ttfb: null, inp: 320 };
    expect(formatMetrics(metrics)).toBe("LCP: N/A | CLS: N/A | TTFB: N/A | INP: 320ms");
  });
});

describe("rateMetrics", () => {
  it("rates good metrics", () => {
    const metrics: WebVitalsMetrics = { lcp: 1000, cls: 0.05, ttfb: 200, inp: 100 };
    expect(rateMetrics(metrics)).toEqual({
      lcp: "good",
      cls: "good",
      ttfb: "good",
      inp: "good",
    });
  });

  it("rates poor metrics", () => {
    const metrics: WebVitalsMetrics = { lcp: 5000, cls: 0.3, ttfb: 2000, inp: 600 };
    expect(rateMetrics(metrics)).toEqual({
      lcp: "poor",
      cls: "poor",
      ttfb: "poor",
      inp: "poor",
    });
  });

  it("rates needs-improvement metrics", () => {
    const metrics: WebVitalsMetrics = { lcp: 3000, cls: 0.15, ttfb: 1000, inp: 300 };
    expect(rateMetrics(metrics)).toEqual({
      lcp: "needs-improvement",
      cls: "needs-improvement",
      ttfb: "needs-improvement",
      inp: "needs-improvement",
    });
  });

  it("returns null for null metrics", () => {
    const metrics: WebVitalsMetrics = { lcp: null, cls: null, ttfb: null, inp: null };
    expect(rateMetrics(metrics)).toEqual({
      lcp: null,
      cls: null,
      ttfb: null,
      inp: null,
    });
  });

  it("handles boundary values — exactly at good threshold is good", () => {
    const metrics: WebVitalsMetrics = { lcp: 2500, cls: 0.1, ttfb: 800, inp: 200 };
    expect(rateMetrics(metrics)).toEqual({
      lcp: "good",
      cls: "good",
      ttfb: "good",
      inp: "good",
    });
  });

  it("handles boundary values — exactly at poor threshold is needs-improvement", () => {
    const metrics: WebVitalsMetrics = { lcp: 4000, cls: 0.25, ttfb: 1800, inp: 500 };
    expect(rateMetrics(metrics)).toEqual({
      lcp: "needs-improvement",
      cls: "needs-improvement",
      ttfb: "needs-improvement",
      inp: "needs-improvement",
    });
  });

  it("handles boundary values — just above poor threshold is poor", () => {
    const metrics: WebVitalsMetrics = { lcp: 4001, cls: 0.251, ttfb: 1801, inp: 501 };
    expect(rateMetrics(metrics)).toEqual({
      lcp: "poor",
      cls: "poor",
      ttfb: "poor",
      inp: "poor",
    });
  });

  it("rates INP good at 200ms threshold", () => {
    expect(rateMetrics({ lcp: null, cls: null, ttfb: null, inp: 200 }).inp).toBe("good");
  });

  it("rates INP needs-improvement between 200ms and 500ms", () => {
    expect(rateMetrics({ lcp: null, cls: null, ttfb: null, inp: 350 }).inp).toBe(
      "needs-improvement",
    );
  });

  it("rates INP poor above 500ms", () => {
    expect(rateMetrics({ lcp: null, cls: null, ttfb: null, inp: 501 }).inp).toBe("poor");
  });
});
