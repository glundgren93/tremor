import { describe, expect, it } from "vitest";
import { type SemanticRegion, selectTrustedRegion, shortRegionId } from "../src/observers/regions";

const region = (overrides: Partial<SemanticRegion> = {}): SemanticRegion => ({
  key: "panel",
  regionId: "abc",
  kind: "section",
  rect: { x: 50, y: 50, width: 200, height: 100 },
  viewport: { width: 1000, height: 500 },
  visibleRatio: 1,
  count: 1,
  ...overrides,
});

describe("region identity", () => {
  it("hashes the same raw structural key identically and different keys differently", () => {
    expect(shortRegionId("testid:panel")).toBe(shortRegionId("testid:panel"));
    expect(shortRegionId("testid:panel")).not.toBe(shortRegionId("id:panel"));
  });
});

describe("selectTrustedRegion", () => {
  it("accepts the IoU .75 boundary and pads the clamped union", () => {
    const after = region({ rect: { x: 50, y: 50, width: 150, height: 100 } });
    expect(selectTrustedRegion([region()], [after], ["panel"])).toEqual({
      region: { x: 26, y: 26, width: 248, height: 148 },
      regionId: "abc",
      sourceKinds: ["section"],
    });
  });
  it.each([
    ["missing", [], [region()], ["panel"]],
    ["multiple", [region()], [region()], ["panel", "other"]],
    ["duplicate", [region({ count: 2 })], [region()], ["panel"]],
    ["body", [region({ kind: "body" })], [region()], ["panel"]],
    ["offscreen", [region({ visibleRatio: 0.94 })], [region()], ["panel"]],
    [
      "unstable",
      [region()],
      [region({ rect: { x: 150, y: 50, width: 200, height: 100 } })],
      ["panel"],
    ],
  ])("falls back for %s regions", (_name, before, after, keys) => {
    expect(
      selectTrustedRegion(before as SemanticRegion[], after as SemanticRegion[], keys as string[]),
    ).toHaveProperty("fallbackReason");
  });
  it("accepts exact size and visibility boundaries and rejects values below them", () => {
    const exact = region({ rect: { x: 50, y: 50, width: 32, height: 32 }, visibleRatio: 0.95 });
    expect(selectTrustedRegion([exact], [exact], ["panel"], 0)).toHaveProperty("region");
    for (const bad of [
      region({ rect: { x: 50, y: 50, width: 31.99, height: 32 } }),
      region({ visibleRatio: 0.949 }),
      region({ rect: { x: Number.NaN, y: 50, width: 200, height: 100 } }),
      region({ rect: { x: 50, y: 50, width: -1, height: 100 } }),
    ])
      expect(selectTrustedRegion([bad], [bad], ["panel"], 0)).toHaveProperty("fallbackReason");
  });
  it("keeps crop coordinates viewport-relative at a nonzero scroll position", () => {
    const scrolled = region({
      rect: { x: 110, y: 220, width: 200, height: 100 },
      viewport: { width: 1000, height: 500, scrollX: 100, scrollY: 200 },
    });
    expect(selectTrustedRegion([scrolled], [scrolled], ["panel"])).toMatchObject({
      region: { x: 86, y: 196, width: 248, height: 148 },
    });
  });
  it("rejects a crop above 80% while accepting exactly 80%", () => {
    const exact = region({ rect: { x: 0, y: 0, width: 800, height: 500 } });
    expect(selectTrustedRegion([exact], [exact], ["panel"], 0)).toHaveProperty("region");
    const over = region({ rect: { x: 0, y: 0, width: 801, height: 500 } });
    expect(selectTrustedRegion([over], [over], ["panel"], 0)).toHaveProperty(
      "fallbackReason",
      "region-too-large",
    );
  });
});
