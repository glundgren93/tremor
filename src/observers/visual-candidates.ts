import type {
  BlankCandidate,
  ClippedCandidate,
  CulpritCandidate,
  ElementContext,
  ImageCandidate,
  Probe,
  TargetCandidate,
} from "./visual-types";

/**
 * Runs in page context — must stay self-contained (no imports, no closure over
 * module scope). Returns facts only; ranking happens above.
 */
export function collectVisualCandidates(): Probe {
  const AD_PATTERN = /\b(ad|ads|adslot|advert|publicidade|banner|gpt|dfp|taboola|outbrain)\b/i;
  const CAROUSEL_PATTERN = /(carousel|slider|swiper|marquee|scroller|track|flickity|glide)/i;
  const MIN_TARGET = 24;
  const MIN_BLANK = 40_000;
  const TOLERANCE = 4;
  /**
   * Clipping below this many pixels cannot hide a readable glyph or a line of
   * text; it is produced by rounded corners, focus rings, line-height rounding
   * and sub-pixel layout. Counted and reported, never silently dropped.
   */
  const MIN_CLIP_PX = 8;

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
  let skippedVisuallyHidden = 0;
  let skippedNegligibleClipping = 0;
  const docScrollsSideways = docEl.scrollWidth > vw + TOLERANCE;
  const replaced = new Set([
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

  function inspectOverflow(el: Element, r: DOMRect, style: CSSStyleDeclaration): void {
    if (!docScrollsSideways || r.width <= 0 || r.right <= vw + TOLERANCE) return;
    const parent = el.parentElement?.getBoundingClientRect();
    if (!parent || parent.right <= vw + TOLERANCE)
      culprits.push({
        ...contextFor(el, r),
        rightEdge: Math.round(r.right),
        exceedsByPx: Math.round(r.right - vw),
        position: style.position,
        widthStyle: style.width,
      });
  }
  const overflows = (el: Element): [boolean, boolean] => [
    el.scrollWidth > el.clientWidth + TOLERANCE,
    el.scrollHeight > el.clientHeight + TOLERANCE,
  ];
  const scrollable = (value: string): boolean => value === "auto" || value === "scroll";
  const clips = (value: string): boolean => value === "hidden" || value === "clip";
  const visuallyHiddenName = (el: Element): boolean =>
    /\b(sr-only|visually-hidden|screen-reader|a11y-hidden)\b/i.test(
      `${el.id} ${typeof el.className === "string" ? el.className : ""}`,
    );
  const isVisuallyHidden = (el: Element, r: DOMRect, style: CSSStyleDeclaration): boolean =>
    visuallyHiddenName(el) ||
    style.clipPath === "inset(50%)" ||
    style.clip === "rect(0px, 0px, 0px, 0px)" ||
    ((style.position === "absolute" || style.position === "fixed") &&
      r.width <= 2 &&
      r.height <= 2 &&
      clips(style.overflowX) &&
      clips(style.overflowY));
  const hasScrollableOverflow = (x: boolean, y: boolean, ox: string, oy: string): boolean =>
    (x && scrollable(ox)) || (y && scrollable(oy));
  const clippingAxes = (x: boolean, y: boolean, ox: string, oy: string): [boolean, boolean] => [
    x && clips(ox),
    y && clips(oy),
  ];
  const clippingAxis = (clipX: boolean, clipY: boolean): "horizontal" | "vertical" | "both" =>
    clipX && clipY ? "both" : clipX ? "horizontal" : "vertical";
  const clippingAmount = (el: Element, clipX: boolean, clipY: boolean): number =>
    Math.max(
      clipX ? el.scrollWidth - el.clientWidth : 0,
      clipY ? el.scrollHeight - el.clientHeight : 0,
    );
  function inspectClipping(el: Element, r: DOMRect, style: CSSStyleDeclaration): void {
    const [overX, overY] = overflows(el),
      ox = style.overflowX,
      oy = style.overflowY;
    if (!overX && !overY) return;
    if (isVisuallyHidden(el, r, style)) {
      skippedVisuallyHidden++;
      return;
    }
    if (hasScrollableOverflow(overX, overY, ox, oy)) {
      skippedScrollable++;
      return;
    }
    const [clipX, clipY] = clippingAxes(overX, overY, ox, oy);
    if (!clipX && !clipY) return;
    const clippedByPx = clippingAmount(el, clipX, clipY);
    if (clippedByPx < MIN_CLIP_PX) {
      skippedNegligibleClipping++;
      return;
    }
    clipped.push({
      ...contextFor(el, r),
      axis: clippingAxis(clipX, clipY),
      clippedByPx,
      computedOverflowX: ox,
      computedOverflowY: oy,
    });
  }
  function inspectImage(el: Element, r: DOMRect): void {
    if (el.tagName !== "IMG") return;
    const img = el as HTMLImageElement;
    if (img.complete && img.naturalWidth === 0 && img.currentSrc)
      images.push({
        ...contextFor(el, r),
        src: img.currentSrc,
        alt: img.getAttribute("alt"),
        loading: img.getAttribute("loading"),
      });
  }
  const isInteractive = (el: Element): boolean =>
    ["BUTTON", "A", "INPUT"].includes(el.tagName) ||
    el.getAttribute("role") === "button" ||
    el.hasAttribute("onclick");
  const hasLargeAncestor = (el: Element): boolean => {
    for (let p = el.parentElement, d = 0; p && d < 3; p = p.parentElement, d++) {
      const pr = p.getBoundingClientRect();
      if (
        (["A", "BUTTON"].includes(p.tagName) || p.getAttribute("role") === "button") &&
        pr.width >= MIN_TARGET &&
        pr.height >= MIN_TARGET
      )
        return true;
    }
    return false;
  };
  function inspectTarget(el: Element, r: DOMRect, style: CSSStyleDeclaration): void {
    if (!isInteractive(el) || isVisuallyHidden(el, r, style) || r.width <= 0 || r.height <= 0)
      return;
    const display = style.display,
      inline = display === "inline" || display === "inline-block";
    const textLink = el.tagName === "A" && inline && (el.textContent ?? "").trim() !== "";
    if (textLink) {
      skippedInlineTextLinks++;
      return;
    }
    // A single short dimension is not enough to establish a WCAG 2.5.8
    // violation: surrounding spacing can satisfy the criterion. Keep this
    // high-confidence probe to controls that are undersized on both axes.
    if (r.width >= MIN_TARGET || r.height >= MIN_TARGET) return;
    const larger = hasLargeAncestor(el);
    targets.push({
      ...contextFor(el, r),
      width: Math.round(r.width),
      height: Math.round(r.height),
      display,
      hasLargerClickableAncestor: larger,
    });
  }
  function inspectBlank(el: Element, r: DOMRect, style: CSSStyleDeclaration): void {
    if (
      replaced.has(el.tagName) ||
      el.childElementCount !== 0 ||
      (el.textContent ?? "").trim() !== ""
    )
      return;
    const area = r.width * r.height,
      background =
        style.backgroundImage !== "none" ||
        (style.backgroundColor !== "rgba(0, 0, 0, 0)" && style.backgroundColor !== "transparent");
    if (
      area >= MIN_BLANK &&
      r.bottom > 0 &&
      r.top < vh &&
      r.right > 0 &&
      r.left < vw &&
      !background
    )
      blanks.push({ ...contextFor(el, r), area });
  }
  for (const el of Array.from(document.querySelectorAll("*"))) {
    scannedElements++;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const r = el.getBoundingClientRect();
    inspectOverflow(el, r, style);
    inspectClipping(el, r, style);
    inspectImage(el, r);
    inspectTarget(el, r, style);
    inspectBlank(el, r, style);
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
    skippedVisuallyHidden,
    skippedNegligibleClipping,
  };
}
