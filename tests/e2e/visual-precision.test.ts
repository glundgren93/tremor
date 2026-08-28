import { chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectVisualCandidates } from "../../src/observers/visual-candidates";

let browser: Awaited<ReturnType<typeof chromium.launch>>;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
});

afterAll(async () => {
  await browser.close();
});

async function probe(body: string, css = "") {
  await page.setContent(`<style>${css}</style>${body}`);
  return page.evaluate(collectVisualCandidates);
}

describe("visual candidate precision", () => {
  it("excludes conventional and computed visually-hidden content from clipping findings", async () => {
    const result = await probe(
      `<span class="sr-only">Premium plan details that intentionally overflow</span>
       <span id="computed-hidden">Screen reader status text that intentionally overflows</span>`,
      `.sr-only, #computed-hidden {
         position: absolute;
         width: 1px;
         height: 1px;
         padding: 0;
         margin: -1px;
         overflow: hidden;
         clip: rect(0, 0, 0, 0);
         white-space: nowrap;
         border: 0;
       }`,
    );

    expect(result.clipped).toEqual([]);
    expect(result.skippedVisuallyHidden).toBe(2);
  });

  it("keeps genuine clipped content", async () => {
    const result = await probe(
      `<div id="clipped"><span>Content that is substantially wider than its container</span></div>`,
      `#clipped { width: 60px; height: 20px; overflow: hidden; white-space: nowrap; }`,
    );

    expect(result.clipped).toHaveLength(1);
    expect(result.clipped[0]?.selector).toBe("div#clipped");
  });

  it("excludes clipping too small to hide a glyph and reports the exclusion", async () => {
    const result = await probe(
      `<div id="barely"><span>Arrow up</span></div>`,
      `#barely { width: 200px; height: 14px; overflow: hidden; }
       #barely span { display: block; height: 20px; }`,
    );

    expect(result.clipped).toEqual([]);
    expect(result.skippedNegligibleClipping).toBe(1);
  });

  it("does not report wide or inline controls solely for a short line box", async () => {
    const result = await probe(
      `<button id="wide">A wide control with an 18px line box</button>
       <a id="inline" href="#">Inline text link</a>`,
      `#wide { display: block; width: 780px; height: 18px; padding: 0; border: 0; }
       #inline { font-size: 12px; line-height: 18px; }`,
    );

    expect(result.targets).toEqual([]);
    expect(result.skippedInlineTextLinks).toBe(1);
  });

  it("retains genuinely tiny controls as candidates", async () => {
    const result = await probe(
      `<button id="tiny" aria-label="Dismiss">×</button>`,
      `#tiny { width: 18px; height: 18px; padding: 0; border: 0; }`,
    );

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]).toMatchObject({ selector: "button#tiny", width: 18, height: 18 });
  });
});
