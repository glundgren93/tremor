/**
 * Visual observer.
 *
 * Emits *candidates with context*, not verdicts. Design rules:
 *
 *  1. Anything CSS already settles is settled in the engine, not sent onward.
 *     `overflow: auto|scroll` means the author opted into overflow.
 *  2. Everything genuinely ambiguous carries the context needed to resolve it:
 *     computed styles, geometry, role, text, carousel/ad-slot ancestry.
 *  3. Candidates are ranked by measured impact, not discovered in DOM order.
 *
 * Two kinds were deleted after benchmarking against globo.com, and the reasons
 * are worth keeping:
 *
 *  - `layout.spilling-content` (overflow:visible where scrollWidth >
 *    clientWidth) fired on 236 of 3336 elements, including <html> itself.
 *    Normal CSS produces this constantly — absolutely positioned children,
 *    negative margins, decorative bleed. Content that is `visible` is by
 *    definition not hidden from the user, so it is not a defect class at all.
 *    What users actually feel is the *document* scrolling sideways, which is
 *    reported once, with its culprit elements.
 *  - Bare "empty container" fired 10× on ad slots and spacers. Only large,
 *    on-screen, background-less blanks survive.
 */

import { createObservation, type Observation } from "../types/observation";
import { err, ok, type Result } from "../types/result";
import type { Observer, ObserverContext } from "./observer";

/** How many ranked candidates get an element screenshot attached. */
const EVIDENCE_LIMIT = 5;
/** How many ranked candidates per kind are emitted at all. */
const EMIT_LIMIT = 8;
/** WCAG 2.5.8 minimum target size (AA). Mirrored as MIN_TARGET in the page probe. */
const MIN_TARGET_PX = 24;

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

/** An element whose right edge is what makes the document scroll sideways. */
type CulpritCandidate = ElementContext & {
  rightEdge: number;
  exceedsByPx: number;
  position: string;
  widthStyle: string;
};

type ImageCandidate = ElementContext & {
  src: string;
  alt: string | null;
  loading: string | null;
};

type TargetCandidate = ElementContext & {
  width: number;
  height: number;
  display: string;
  hasLargerClickableAncestor: boolean;
};

type BlankCandidate = ElementContext & { area: number };

type Probe = {
  documentScroll: {
    horizontal: boolean;
    scrollWidth: number;
    clientWidth: number;
    overflowByPx: number;
  };
  culprits: CulpritCandidate[];
  clipped: ClippedCandidate[];
  images: ImageCandidate[];
  targets: TargetCandidate[];
  blanks: BlankCandidate[];
  scannedElements: number;
  skippedScrollable: number;
  skippedInlineTextLinks: number;
};

export const visualObserver: Observer = {
  name: "visual",
  async run(ctx: ObserverContext): Promise<Result<Observation[]>> {
    const probed = await ctx.driver.evaluate(collectVisualCandidates);
    if (!probed.ok) return err(probed.error);

    const probe = probed.value;
    const out: Observation[] = [];

    if (probe.documentScroll.horizontal) {
      out.push(
        createObservation({
          kind: "layout.document-horizontal-scroll",
          summary: `Document scrolls horizontally by ${probe.documentScroll.overflowByPx}px at ${probe.documentScroll.clientWidth}px wide`,
          facts: {
            ...probe.documentScroll,
            culpritCount: probe.culprits.length,
          },
          target: { selector: "html", url: ctx.url },
        }),
      );

      for (const c of rank(probe.culprits, (x) => x.exceedsByPx).slice(0, EMIT_LIMIT)) {
        out.push(
          createObservation({
            kind: "layout.overflow-culprit",
            summary: `${c.tag} extends ${c.exceedsByPx}px past the viewport's right edge while its parent does not`,
            facts: {
              exceedsByPx: c.exceedsByPx,
              rightEdge: c.rightEdge,
              viewportWidth: probe.documentScroll.clientWidth,
              position: c.position,
              widthStyle: c.widthStyle,
              rect: c.rect,
              textSample: c.textSample,
              role: c.role,
              looksLikeAdSlot: c.looksLikeAdSlot,
            },
            target: { selector: c.selector, url: ctx.url },
          }),
        );
      }
    }

    // body/html clipping is the document-scroll observation seen from the other
    // side — reporting both says the same thing twice.
    const clipCandidates = probe.documentScroll.horizontal
      ? probe.clipped.filter((c) => c.tag !== "body" && c.tag !== "html")
      : probe.clipped;

    const clipGroups = collapse(clipCandidates, (c) => c.clippedByPx);
    for (const g of rank(clipGroups, (x) => clippedScore(x.representative)).slice(0, EMIT_LIMIT)) {
      const c = g.representative;
      out.push(
        createObservation({
          kind: "layout.clipped-content",
          summary:
            g.occurrences > 1
              ? `${c.tag} hides ${c.clippedByPx}px of ${c.axis} content behind overflow:${c.computedOverflowX}/${c.computedOverflowY} (${g.occurrences} instances of this component)`
              : `${c.tag} hides ${c.clippedByPx}px of ${c.axis} content behind overflow:${c.computedOverflowX}/${c.computedOverflowY}`,
          facts: {
            axis: c.axis,
            clippedByPx: c.clippedByPx,
            computedOverflowX: c.computedOverflowX,
            computedOverflowY: c.computedOverflowY,
            occurrences: g.occurrences,
            sampleSelectors: g.sampleSelectors,
            rect: c.rect,
            inViewport: c.inViewport,
            textSample: c.textSample,
            role: c.role,
            ariaLabel: c.ariaLabel,
            // Surfaced as context, never used to silently drop the candidate.
            looksLikeAdSlot: c.looksLikeAdSlot,
            inCarouselAncestor: c.inCarouselAncestor,
          },
          target: { selector: c.selector, url: ctx.url },
        }),
      );
    }

    for (const c of probe.images) {
      out.push(
        createObservation({
          kind: "media.image-unresolved",
          summary: `<img> finished loading with zero intrinsic width (src="${truncate(c.src, 120)}")`,
          facts: {
            src: c.src,
            alt: c.alt,
            loading: c.loading,
            rect: c.rect,
            inViewport: c.inViewport,
          },
          target: { selector: c.selector, url: ctx.url },
        }),
      );
    }

    const targetGroups = collapse(probe.targets, (c) => Math.min(c.width, c.height));
    for (const g of rank(targetGroups, (x) => x.occurrences).slice(0, EMIT_LIMIT)) {
      const c = g.representative;
      out.push(
        createObservation({
          kind: "a11y.small-target",
          summary:
            g.occurrences > 1
              ? `${g.occurrences} interactive ${c.tag} elements measure about ${c.width}×${c.height}px; WCAG 2.5.8 minimum is ${MIN_TARGET_PX}×${MIN_TARGET_PX}`
              : `Interactive ${c.tag} (display:${c.display}) measures ${c.width}×${c.height}px; WCAG 2.5.8 minimum is ${MIN_TARGET_PX}×${MIN_TARGET_PX}`,
          facts: {
            width: c.width,
            height: c.height,
            minimumPx: MIN_TARGET_PX,
            display: c.display,
            occurrences: g.occurrences,
            sampleSelectors: g.sampleSelectors,
            hasLargerClickableAncestor: c.hasLargerClickableAncestor,
            role: c.role,
            ariaLabel: c.ariaLabel,
            textSample: c.textSample,
            inViewport: c.inViewport,
          },
          target: { selector: c.selector, url: ctx.url },
        }),
      );
    }

    for (const c of rank(probe.blanks, (b) => b.area).slice(0, EMIT_LIMIT)) {
      out.push(
        createObservation({
          kind: "layout.blank-region",
          summary: `${Math.round(c.rect.width)}×${Math.round(c.rect.height)}px on-screen region renders no content`,
          facts: {
            area: c.area,
            rect: c.rect,
            looksLikeAdSlot: c.looksLikeAdSlot,
            role: c.role,
          },
          target: { selector: c.selector, url: ctx.url },
        }),
      );
    }

    await attachElementEvidence(ctx, out);

    // Coverage is stated, never silently truncated.
    out.push(
      createObservation({
        kind: "scan.coverage",
        summary: `Scanned ${probe.scannedElements} elements; excluded ${probe.skippedScrollable} author-intended scroll containers and ${probe.skippedInlineTextLinks} inline text links`,
        facts: {
          scannedElements: probe.scannedElements,
          skippedScrollable: probe.skippedScrollable,
          skippedInlineTextLinks: probe.skippedInlineTextLinks,
          found: {
            culprits: probe.culprits.length,
            clipped: probe.clipped.length,
            images: probe.images.length,
            targets: probe.targets.length,
            blanks: probe.blanks.length,
          },
          emitLimit: EMIT_LIMIT,
        },
        target: { selector: null, url: ctx.url },
      }),
    );

    return ok(out);
  },
};

function clippedScore(c: ClippedCandidate): number {
  const area = Math.max(c.rect.width * c.rect.height, 1);
  let score = c.clippedByPx * Math.log10(area + 10);
  if (!c.inViewport) score *= 0.3;
  if (c.looksLikeAdSlot) score *= 0.2;
  if (c.inCarouselAncestor) score *= 0.3;
  if (c.textSample.length > 0) score *= 1.5;
  return score;
}

function rank<T>(items: T[], score: (item: T) => number): T[] {
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
function collapse<T extends ElementContext>(
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

async function attachElementEvidence(
  ctx: ObserverContext,
  observations: Observation[],
): Promise<void> {
  const withTargets = observations.filter((o) => o.target.selector && o.kind !== "scan.coverage");
  for (const obs of withTargets.slice(0, EVIDENCE_LIMIT)) {
    const shot = await ctx.driver.screenshot({ label: `${obs.kind}-${obs.id}` });
    if (shot.ok) obs.evidence.push(shot.value);
  }
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Runs in page context — must stay self-contained (no imports, no closure over
 * module scope). Returns facts only; ranking happens above.
 */
function collectVisualCandidates(): Probe {
  const AD_PATTERN = /\b(ad|ads|adslot|advert|publicidade|banner|gpt|dfp|taboola|outbrain)\b/i;
  const CAROUSEL_PATTERN = /(carousel|slider|swiper|marquee|scroller|track|flickity|glide)/i;
  const MIN_TARGET = 24;
  const MIN_BLANK = 40_000;
  const TOLERANCE = 4;

  const docEl = document.documentElement;
  const vw = docEl.clientWidth;
  const vh = docEl.clientHeight;

  function selectorFor(el: Element): string {
    const tag = el.tagName.toLowerCase();
    if (el.id) return `${tag}#${CSS.escape(el.id)}`;
    const cls =
      typeof el.className === "string" && el.className.trim()
        ? `.${el.className
            .trim()
            .split(/\s+/)
            .slice(0, 2)
            .map((c) => CSS.escape(c))
            .join(".")}`
        : "";
    if (!cls && el.parentElement) {
      const idx = Array.from(el.parentElement.children).indexOf(el) + 1;
      return `${selectorFor(el.parentElement)} > ${tag}:nth-child(${idx})`;
    }
    return `${tag}${cls}`;
  }

  function contextFor(el: Element, r: DOMRect): ElementContext {
    const text = (el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
    const own = `${el.id} ${typeof el.className === "string" ? el.className : ""}`;

    let inCarousel = CAROUSEL_PATTERN.test(own);
    for (let p = el.parentElement, d = 0; p && d < 6 && !inCarousel; p = p.parentElement, d++) {
      inCarousel = CAROUSEL_PATTERN.test(
        `${p.id} ${typeof p.className === "string" ? p.className : ""}`,
      );
    }

    return {
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role"),
      ariaLabel: el.getAttribute("aria-label"),
      textSample: text,
      rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      inViewport: r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw,
      childCount: el.childElementCount,
      looksLikeAdSlot: AD_PATTERN.test(own),
      inCarouselAncestor: inCarousel,
    };
  }

  const culprits: CulpritCandidate[] = [];
  const clipped: ClippedCandidate[] = [];
  const images: ImageCandidate[] = [];
  const targets: TargetCandidate[] = [];
  const blanks: BlankCandidate[] = [];
  let scannedElements = 0;
  let skippedScrollable = 0;
  let skippedInlineTextLinks = 0;

  const docScrollsSideways = docEl.scrollWidth > vw + TOLERANCE;

  for (const el of Array.from(document.querySelectorAll("*"))) {
    scannedElements++;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();

    // --- what makes the page scroll sideways ---------------------------------
    // Only the innermost offender is useful: an overflowing child does not
    // stretch its parent's border box, so the culprit is the element that
    // exceeds the viewport while its parent still fits.
    if (docScrollsSideways && r.width > 0 && r.right > vw + TOLERANCE) {
      const parentRect = el.parentElement?.getBoundingClientRect();
      const parentFits = !parentRect || parentRect.right <= vw + TOLERANCE;
      if (parentFits) {
        culprits.push({
          ...contextFor(el, r),
          rightEdge: Math.round(r.right),
          exceedsByPx: Math.round(r.right - vw),
          position: style.position,
          widthStyle: style.width,
        });
      }
    }

    // --- content the author is hiding ----------------------------------------
    const ox = style.overflowX;
    const oy = style.overflowY;
    const overX = el.scrollWidth > el.clientWidth + TOLERANCE;
    const overY = el.scrollHeight > el.clientHeight + TOLERANCE;

    if (overX || overY) {
      const scrollableX = ox === "auto" || ox === "scroll";
      const scrollableY = oy === "auto" || oy === "scroll";
      if ((overX && scrollableX) || (overY && scrollableY)) {
        skippedScrollable++;
      } else {
        const clipX = overX && (ox === "hidden" || ox === "clip");
        const clipY = overY && (oy === "hidden" || oy === "clip");
        // overflow:visible is not a defect — the content is still on screen.
        // Its only user-visible consequence is document scroll, handled above.
        if (clipX || clipY) {
          clipped.push({
            ...contextFor(el, r),
            axis: clipX && clipY ? "both" : clipX ? "horizontal" : "vertical",
            clippedByPx: Math.max(
              clipX ? el.scrollWidth - el.clientWidth : 0,
              clipY ? el.scrollHeight - el.clientHeight : 0,
            ),
            computedOverflowX: ox,
            computedOverflowY: oy,
          });
        }
      }
    }

    if (el.tagName === "IMG") {
      const img = el as HTMLImageElement;
      // An un-started lazy image is not a failure; only decided ones count.
      if (img.complete && img.naturalWidth === 0 && img.currentSrc) {
        images.push({
          ...contextFor(el, r),
          src: img.currentSrc,
          alt: img.getAttribute("alt"),
          loading: img.getAttribute("loading"),
        });
      }
    }

    // --- tap targets ---------------------------------------------------------
    const interactive =
      el.tagName === "BUTTON" ||
      el.tagName === "A" ||
      el.tagName === "INPUT" ||
      el.getAttribute("role") === "button" ||
      el.hasAttribute("onclick");

    // Screen-reader-only skip links are deliberately 1px and are a correct
    // pattern, not an undersized target.
    const visuallyHidden =
      style.clipPath === "inset(50%)" ||
      style.clip === "rect(0px, 0px, 0px, 0px)" ||
      /\b(sr-only|visually-hidden|screen-reader|a11y-hidden)\b/i.test(
        `${el.id} ${typeof el.className === "string" ? el.className : ""}`,
      );

    if (interactive && !visuallyHidden && r.width > 0 && r.height > 0) {
      const display = style.display;
      const isInline = display === "inline" || display === "inline-block";
      // WCAG 2.5.8 exempts links in a block of text. A 185×22 headline link in
      // a news feed is not a defect; a 16×16 icon button is.
      const inlineTextLink = el.tagName === "A" && isInline && (el.textContent ?? "").trim() !== "";
      const bothSmall = r.width < MIN_TARGET && r.height < MIN_TARGET;

      if (inlineTextLink && !bothSmall) {
        skippedInlineTextLinks++;
      } else if (bothSmall || (!isInline && (r.width < MIN_TARGET || r.height < MIN_TARGET))) {
        let larger = false;
        for (let p = el.parentElement, d = 0; p && d < 3; p = p.parentElement, d++) {
          const pr = p.getBoundingClientRect();
          const clickable =
            p.tagName === "A" || p.tagName === "BUTTON" || p.getAttribute("role") === "button";
          if (clickable && pr.width >= MIN_TARGET && pr.height >= MIN_TARGET) {
            larger = true;
            break;
          }
        }
        targets.push({
          ...contextFor(el, r),
          width: Math.round(r.width),
          height: Math.round(r.height),
          display,
          hasLargerClickableAncestor: larger,
        });
      }
    }

    // --- holes in the page ---------------------------------------------------
    // Replaced elements have no child nodes by definition — an <img>, an ad
    // <iframe>, or a <canvas> paints content the DOM cannot see, so treating
    // "no children" as "renders nothing" reports them as holes incorrectly.
    const REPLACED = new Set([
      "IMG",
      "IFRAME",
      "VIDEO",
      "AUDIO",
      "CANVAS",
      "SVG",
      "OBJECT",
      "EMBED",
      "INPUT",
      "TEXTAREA",
      "SELECT",
      "PICTURE",
      "HR",
      "BR",
    ]);

    if (
      !REPLACED.has(el.tagName) &&
      el.childElementCount === 0 &&
      (el.textContent ?? "").trim() === ""
    ) {
      const area = r.width * r.height;
      const hasBackground =
        style.backgroundImage !== "none" ||
        (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent");
      const onScreen = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      if (area >= MIN_BLANK && onScreen && !hasBackground) {
        blanks.push({ ...contextFor(el, r), area });
      }
    }
  }

  return {
    documentScroll: {
      horizontal: docScrollsSideways,
      scrollWidth: docEl.scrollWidth,
      clientWidth: vw,
      overflowByPx: Math.max(0, docEl.scrollWidth - vw),
    },
    culprits,
    clipped,
    images,
    targets,
    blanks,
    scannedElements,
    skippedScrollable,
    skippedInlineTextLinks,
  };
}
