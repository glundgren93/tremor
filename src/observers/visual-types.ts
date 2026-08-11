export type Rect = { x: number; y: number; width: number; height: number };

export type ElementContext = {
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

export type ClippedCandidate = ElementContext & {
  axis: "horizontal" | "vertical" | "both";
  clippedByPx: number;
  computedOverflowX: string;
  computedOverflowY: string;
};

/** An element whose right edge is what makes the document scroll sideways. */
export type CulpritCandidate = ElementContext & {
  rightEdge: number;
  exceedsByPx: number;
  position: string;
  widthStyle: string;
};

export type ImageCandidate = ElementContext & {
  src: string;
  alt: string | null;
  loading: string | null;
};

export type TargetCandidate = ElementContext & {
  width: number;
  height: number;
  display: string;
  hasLargerClickableAncestor: boolean;
};

export type BlankCandidate = ElementContext & { area: number };

export type Probe = {
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
