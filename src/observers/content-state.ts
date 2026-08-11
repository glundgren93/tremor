export type ContentState = {
  visibleTextLength: number;
  textSample: string;
  elementCount: number;
  headings: string[];
  /** Text nodes that read like a failure surfaced to the user. */
  errorPhrases: string[];
  /** Elements conventionally used for loading state, still present. */
  spinnerCount: number;
  imageCount: number;
  linkCount: number;
  title: string;
  controlCounts?: Record<string, number>;
  blankPanelCount?: number;
  skeletonCount?: number;
  nonemptyControlCount?: number;
  regions?: import("./regions").SemanticRegion[];
  /** Internal fingerprints only; never emitted as observation facts. */
  regionFingerprints?: Record<string, string>;
  /** Opaque safe-text digests used only to mark textContent changes. */
  regionTextFingerprints?: Record<string, string>;
};
