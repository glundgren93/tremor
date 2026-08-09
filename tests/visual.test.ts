import { describe, expect, it } from "vitest";
import type { Driver } from "../src/driver/driver";
import { visualObserver } from "../src/observers/visual";
import { ok } from "../src/types/result";

const candidate = {
  selector: "#broken",
  tag: "div",
  role: null,
  ariaLabel: null,
  textSample: "broken",
  rect: { x: 0, y: 0, width: 100, height: 100 },
  inViewport: true,
  childCount: 0,
  looksLikeAdSlot: false,
  inCarouselAncestor: false,
  axis: "horizontal" as const,
  clippedByPx: 20,
  computedOverflowX: "visible",
  computedOverflowY: "visible",
};

function driver(screenshots: string[]): Driver {
  return {
    backend: "playwright",
    navigate: async () => ok({ url: "https://app.test/", status: 200, durationMs: 1 }),
    reload: async () => ok({ url: "https://app.test/", status: 200, durationMs: 1 }),
    waitForIdle: async () => ok(undefined),
    currentUrl: () => "https://app.test/",
    evaluate: async () =>
      ok({
        documentScroll: { horizontal: true, scrollWidth: 110, clientWidth: 100, overflowByPx: 10 },
        culprits: [],
        clipped: [candidate],
        images: [],
        targets: [],
        blanks: [],
        scannedElements: 1,
        skippedScrollable: 0,
        skippedInlineTextLinks: 0,
      }),
    screenshot: async ({ label }) => {
      screenshots.push(label);
      return ok({ kind: "screenshot" as const, path: `/tmp/${label}.png`, label, capturedAt: 1 });
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

describe("visual observer evidence", () => {
  it("keeps observations but skips screenshots when captureEvidence is false", async () => {
    const screenshots: string[] = [];
    const result = await visualObserver.run({
      driver: driver(screenshots),
      url: "https://app.test/",
      captureEvidence: false,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.length).toBeGreaterThan(0);
    expect(screenshots).toEqual([]);
  });
});
