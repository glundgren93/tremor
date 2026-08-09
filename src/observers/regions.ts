import { createHash } from "node:crypto";
import type { ScreenshotRegion } from "../driver/driver";

export type SemanticRegion = {
  key: string;
  regionId: string;
  kind: string;
  label?: string;
  rect: ScreenshotRegion;
  viewport: { width: number; height: number; scrollX?: number; scrollY?: number };
  visibleRatio: number;
  count: number;
};

export type RegionChoice =
  | { region: ScreenshotRegion; regionId: string; sourceKinds: string[] }
  | { fallbackReason: string };

const iou = (a: ScreenshotRegion, b: ScreenshotRegion) => {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.width, b.x + b.width),
    d = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, r - x) * Math.max(0, d - y);
  return intersection / (a.width * a.height + b.width * b.height - intersection);
};

/** Deterministic, conservative crop gate. */
export function selectTrustedRegion(
  baseline: SemanticRegion[],
  faulted: SemanticRegion[],
  changedKeys: string[],
  padding = 24,
): RegionChoice {
  const keys = [...new Set(changedKeys)];
  if (keys.length !== 1)
    return { fallbackReason: keys.length ? "multiple-regions" : "missing-region" };
  const before = baseline.filter((r) => r.key === keys[0]);
  const after = faulted.filter((r) => r.key === keys[0]);
  const a = before[0],
    b = after[0];
  if (before.length !== 1 || after.length !== 1 || !a || !b || a.count !== 1 || b.count !== 1)
    return { fallbackReason: "missing-or-duplicate-region" };
  if (a.kind === "body" || b.kind === "body") return { fallbackReason: "body-region" };
  if (
    [a, b].some(
      (r) =>
        r.visibleRatio < 0.95 ||
        r.rect.width < 32 ||
        r.rect.height < 32 ||
        !Object.values(r.rect).every(Number.isFinite),
    )
  )
    return { fallbackReason: "offscreen-or-small-region" };
  if (iou(a.rect, b.rect) < 0.75) return { fallbackReason: "geometry-drift" };
  const vw = b.viewport.width,
    vh = b.viewport.height;
  // getBoundingClientRect and Playwright's non-full-page clip both use viewport CSS pixels.
  const x = Math.max(0, Math.min(a.rect.x, b.rect.x) - padding);
  const y = Math.max(0, Math.min(a.rect.y, b.rect.y) - padding);
  const right = Math.min(vw, Math.max(a.rect.x + a.rect.width, b.rect.x + b.rect.width) + padding);
  const bottom = Math.min(
    vh,
    Math.max(a.rect.y + a.rect.height, b.rect.y + b.rect.height) + padding,
  );
  const region = { x, y, width: right - x, height: bottom - y };
  if (region.width <= 0 || region.height <= 0)
    return { fallbackReason: "offscreen-or-small-region" };
  if (region.width * region.height > vw * vh * 0.8) return { fallbackReason: "region-too-large" };
  return { region, regionId: b.regionId, sourceKinds: [b.kind] };
}

export function shortRegionId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 12);
}
