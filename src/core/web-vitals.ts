import type { WebVitalsMetrics } from "./types";

/** JavaScript to inject via addInitScript — sets up PerformanceObservers for LCP, CLS, and TTFB */
export const WEB_VITALS_INIT_SCRIPT = `
(() => {
  try {
    window.__tremor_metrics = { lcp: null, cls: null, ttfb: null, inp: null };

    // LCP — take the last entry reported
    try {
      new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length > 0) {
          window.__tremor_metrics.lcp = entries[entries.length - 1].startTime;
        }
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    } catch {}

    // CLS — accumulate layout shift values, excluding those with recent input
    try {
      let clsValue = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!entry.hadRecentInput) {
            clsValue += entry.value;
          }
        }
        window.__tremor_metrics.cls = clsValue;
      }).observe({ type: 'layout-shift', buffered: true });
    } catch {}

    // TTFB — read from navigation timing on load
    try {
      const readTTFB = () => {
        const nav = performance.getEntriesByType('navigation')[0];
        if (nav && nav.responseStart > 0) {
          window.__tremor_metrics.ttfb = nav.responseStart - nav.startTime;
        }
      };
      if (document.readyState === 'complete') {
        readTTFB();
      } else {
        window.addEventListener('load', readTTFB);
      }
    } catch {}

    // INP — track worst interaction duration by interactionId
    try {
      const interactions = new Map();
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.interactionId) {
            const existing = interactions.get(entry.interactionId) || 0;
            if (entry.duration > existing) {
              interactions.set(entry.interactionId, entry.duration);
            }
          }
        }
        // INP = worst interaction duration (simplified, accurate for <50 interactions)
        let worst = 0;
        for (const dur of interactions.values()) {
          if (dur > worst) worst = dur;
        }
        if (interactions.size > 0) {
          window.__tremor_metrics.inp = worst;
        }
      }).observe({ type: 'event', durationThreshold: 16, buffered: true });
    } catch {}
  } catch {}
})();
`;

type MetricRating = "good" | "needs-improvement" | "poor";

export type MetricRatings = {
  lcp: MetricRating | null;
  cls: MetricRating | null;
  ttfb: MetricRating | null;
  inp: MetricRating | null;
};

/** Format metrics as a human-readable summary string */
export function formatMetrics(metrics: WebVitalsMetrics): string {
  const parts: string[] = [];
  parts.push(`LCP: ${metrics.lcp !== null ? `${Math.round(metrics.lcp)}ms` : "N/A"}`);
  parts.push(`CLS: ${metrics.cls !== null ? metrics.cls.toFixed(3) : "N/A"}`);
  parts.push(`TTFB: ${metrics.ttfb !== null ? `${Math.round(metrics.ttfb)}ms` : "N/A"}`);
  parts.push(`INP: ${metrics.inp !== null ? `${Math.round(metrics.inp)}ms` : "N/A"}`);
  return parts.join(" | ");
}

/** Rate each metric as good / needs-improvement / poor per Google thresholds */
export function rateMetrics(metrics: WebVitalsMetrics): MetricRatings {
  return {
    lcp: rateValue(metrics.lcp, 2500, 4000),
    cls: rateValue(metrics.cls, 0.1, 0.25),
    ttfb: rateValue(metrics.ttfb, 800, 1800),
    inp: rateValue(metrics.inp, 200, 500),
  };
}

function rateValue(
  value: number | null,
  goodThreshold: number,
  poorThreshold: number,
): MetricRating | null {
  if (value === null) return null;
  if (value <= goodThreshold) return "good";
  if (value <= poorThreshold) return "needs-improvement";
  return "poor";
}
