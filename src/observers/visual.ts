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
import { attachElementEvidence, clippedScore, collapse, rank, truncate } from "./visual-ranking";

/** How many ranked candidates per kind are emitted at all. */
const EMIT_LIMIT = 8;
/** WCAG 2.5.8 minimum target size (AA). Mirrored as MIN_TARGET in the page probe. */
const MIN_TARGET_PX = 24;

import { collectVisualCandidates } from "./visual-candidates";

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

    if (ctx.captureEvidence !== false) await attachElementEvidence(ctx, out);

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
