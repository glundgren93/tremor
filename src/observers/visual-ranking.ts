import type { Observation } from "../types/observation";
import type { ObserverContext } from "./observer";

const EVIDENCE_LIMIT = 5;
type Rect = { x: number; y: number; width: number; height: number };
type ElementContext = {
  selector: string;
  tag: string;
  role: string | null;
  ariaLabel: string | null;
  textSample: string;
  rect: Rect;
  inViewport: boolean;
  childCount: number;
  looksLikeAdSlot: boolean;
  inCarouselAncestor: boolean;
};
type ClippedCandidate = ElementContext & {
  axis: "horizontal" | "vertical" | "both";
  clippedByPx: number;
  computedOverflowX: string;
  computedOverflowY: string;
};

export function clippedScore(c: ClippedCandidate): number {
  const area = Math.max(c.rect.width * c.rect.height, 1);
  let score = c.clippedByPx * Math.log10(area + 10);
  if (!c.inViewport) score *= 0.3;
  if (c.looksLikeAdSlot) score *= 0.2;
  if (c.inCarouselAncestor) score *= 0.3;
  if (c.textSample.length > 0) score *= 1.5;
  return score;
}

export function rank<T>(items: T[], score: (item: T) => number): T[] {
  return [...items].sort((a, b) => score(b) - score(a));
}

/**
 * Repeated components are one observation, not N.
 *
 * A news feed renders the same line-clamped card 40 times; globo.com produced
 * five identical `div.post__link hides 200px` entries. Judging the same
 * component once and reporting how often it occurs is strictly more useful
 * than five copies crowding out unrelated candidates.
 */
export function collapse<T extends ElementContext>(
  items: T[],
  magnitude: (item: T) => number,
): { representative: T; occurrences: number; sampleSelectors: string[] }[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    // Bucket magnitude so near-identical instances group; keep the element's
    // structural shape so different components stay apart. Positional suffixes
    // are stripped — `a:nth-child(2)` and `a:nth-child(5)` under one parent are
    // the same component rendered twice, not two candidates.
    const parts = item.selector.split(" > ");
    const shape = parts
      .slice(-2)
      .join(">")
      .replace(/:nth-child\(\d+\)/g, "");
    const key = `${item.tag}|${shape}|${Math.round(magnitude(item) / 10)}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  return [...groups.values()].map((bucket) => ({
    representative: bucket[0] as T,
    occurrences: bucket.length,
    sampleSelectors: bucket.slice(0, 3).map((b) => b.selector),
  }));
}

export async function attachElementEvidence(
  ctx: ObserverContext,
  observations: Observation[],
): Promise<void> {
  const withTargets = observations.filter((o) => o.target.selector && o.kind !== "scan.coverage");
  for (const obs of withTargets.slice(0, EVIDENCE_LIMIT)) {
    const shot = await ctx.driver.screenshot({
      label: `${obs.kind}-${obs.id}`,
    });
    if (shot.ok) obs.evidence.push(shot.value);
  }
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
