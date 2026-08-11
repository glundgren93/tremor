import { createObservation, type Observation } from "../types/observation";
import type { ContentState } from "./content-state";

const TEXT_LOSS_RATIO = 0.2;

export function diffContent(baseline: ContentState, faulted: ContentState): Observation[] {
  return [
    ...diffControlCounts(baseline, faulted),
    ...diffPanelState(baseline, faulted),
    ...diffText(baseline, faulted),
    ...diffRegions(baseline, faulted),
    ...diffErrorsAndSections(baseline, faulted),
    ...diffLoadingAndElements(baseline, faulted),
    ...diffTitle(baseline, faulted),
  ];
}

function diffPanelState(baseline: ContentState, faulted: ContentState): Observation[] {
  const out: Observation[] = [];
  const blankBefore = baseline.blankPanelCount ?? 0;
  const blankAfter = faulted.blankPanelCount ?? 0;
  if (blankBefore !== blankAfter)
    out.push(
      createObservation({
        kind:
          blankAfter > blankBefore
            ? "content.blank-panel-appeared"
            : "content.blank-panel-disappeared",
        summary: `${Math.abs(blankAfter - blankBefore)} blank panel(s) ${blankAfter > blankBefore ? "appeared" : "disappeared"}`,
        facts: { baseline: blankBefore, faulted: blankAfter },
        target: { selector: null, url: null },
      }),
    );
  const skeletonBefore = baseline.skeletonCount ?? baseline.spinnerCount;
  const skeletonAfter = faulted.skeletonCount ?? faulted.spinnerCount;
  if (skeletonBefore !== skeletonAfter)
    out.push(
      createObservation({
        kind: "content.skeleton-count-changed",
        summary: `Skeleton count changed from ${skeletonBefore} to ${skeletonAfter}`,
        facts: { baseline: skeletonBefore, faulted: skeletonAfter },
        target: { selector: null, url: null },
      }),
    );
  const filledBefore = baseline.nonemptyControlCount ?? 0;
  const filledAfter = faulted.nonemptyControlCount ?? 0;
  if (filledAfter < filledBefore)
    out.push(
      createObservation({
        kind: "content.nonempty-controls-lost",
        summary: `${filledBefore - filledAfter} previously nonempty control(s) are now empty or missing`,
        facts: { count: filledBefore - filledAfter },
        target: { selector: null, url: null },
      }),
    );
  return out;
}

function diffText(baseline: ContentState, faulted: ContentState): Observation[] {
  const lost = baseline.visibleTextLength - faulted.visibleTextLength;
  if (baseline.visibleTextLength > 0 && lost / baseline.visibleTextLength >= TEXT_LOSS_RATIO)
    return [
      createObservation({
        kind: "content.text-lost",
        summary: `Visible text fell from ${baseline.visibleTextLength} to ${faulted.visibleTextLength} characters (${Math.round((lost / baseline.visibleTextLength) * 100)}% gone)`,
        facts: {
          baselineChars: baseline.visibleTextLength,
          faultedChars: faulted.visibleTextLength,
          percentLost: Math.round((lost / baseline.visibleTextLength) * 100),
          faultedSample: faulted.textSample,
        },
        target: { selector: "body", url: null },
      }),
    ];
  if (
    lost / Math.max(1, baseline.visibleTextLength) < TEXT_LOSS_RATIO &&
    baseline.textSample !== faulted.textSample
  )
    return [
      createObservation({
        kind: "content.text-changed",
        summary: "Visible page text changed",
        facts: {
          baselineChars: baseline.visibleTextLength,
          faultedChars: faulted.visibleTextLength,
        },
        target: { selector: null, url: null },
      }),
    ];
  return [];
}

function diffRegions(baseline: ContentState, faulted: ContentState): Observation[] {
  const changed = changedSemanticRegionKeys(baseline, faulted);
  if (changed.length === 0) return [];
  const ids = changed
    .map((key) => faulted.regions?.find((region) => region.key === key)?.regionId)
    .filter((id): id is string => !!id);
  return [
    createObservation({
      kind: "content.region-changed",
      summary: `${changed.length} semantic region(s) changed`,
      facts: { count: changed.length, regionIds: ids },
      target: { selector: null, url: null },
    }),
  ];
}

function diffErrorsAndSections(baseline: ContentState, faulted: ContentState): Observation[] {
  const out: Observation[] = [];
  const newPhrases = faulted.errorPhrases.filter((p) => !baseline.errorPhrases.includes(p));
  if (newPhrases.length > 0)
    out.push(
      createObservation({
        kind: "content.error-text-appeared",
        summary: `Error text appeared that was not present before: ${newPhrases.slice(0, 3).join(" | ")}`,
        facts: {
          phrases: newPhrases.slice(0, 5),
          baselinePhrases: baseline.errorPhrases.length,
        },
        target: { selector: "body", url: null },
      }),
    );
  if (
    newPhrases.length === 0 &&
    baseline.visibleTextLength - faulted.visibleTextLength <= 0 &&
    faulted.visibleTextLength > 0
  ) {
    const missing = baseline.headings.filter((h) => !faulted.headings.includes(h));
    if (missing.length > 0)
      out.push(
        createObservation({
          kind: "content.section-missing",
          summary: `Sections disappeared with no error shown: ${missing.slice(0, 3).join(", ")}`,
          facts: { missingHeadings: missing.slice(0, 5) },
          target: { selector: "body", url: null },
        }),
      );
  }
  return out;
}

function diffLoadingAndElements(baseline: ContentState, faulted: ContentState): Observation[] {
  const out: Observation[] = [];
  if (faulted.spinnerCount > baseline.spinnerCount)
    out.push(
      createObservation({
        kind: "content.spinner-persisted",
        summary: `${faulted.spinnerCount} loading indicators still present after load (baseline had ${baseline.spinnerCount})`,
        facts: {
          baseline: baseline.spinnerCount,
          faulted: faulted.spinnerCount,
        },
        target: { selector: "body", url: null },
      }),
    );
  const drop = baseline.elementCount - faulted.elementCount;
  if (baseline.elementCount > 0 && drop / baseline.elementCount >= TEXT_LOSS_RATIO)
    out.push(
      createObservation({
        kind: "content.elements-lost",
        summary: `DOM shrank from ${baseline.elementCount} to ${faulted.elementCount} elements`,
        facts: {
          baseline: baseline.elementCount,
          faulted: faulted.elementCount,
        },
        target: { selector: "body", url: null },
      }),
    );
  return out;
}

function diffTitle(baseline: ContentState, faulted: ContentState): Observation[] {
  if (baseline.title === faulted.title) return [];
  return [
    createObservation({
      kind: "content.title-changed",
      summary: `Document title changed from "${baseline.title}" to "${faulted.title}"`,
      facts: { baseline: baseline.title, faulted: faulted.title },
      target: { selector: "title", url: null },
    }),
  ];
}

function diffControlCounts(baseline: ContentState, faulted: ContentState): Observation[] {
  const observations: Observation[] = [];
  for (const type of ["button", "checkbox", "radio", "select", "textbox"]) {
    const before = baseline.controlCounts?.[type] ?? 0;
    const after = faulted.controlCounts?.[type] ?? 0;
    if (before === after) continue;
    const direction = after > before ? "appeared" : "disappeared";
    observations.push(
      createObservation({
        kind: after > before ? "content.controls-added" : "content.controls-removed",
        summary: `${Math.abs(after - before)} ${type} control(s) ${direction}`,
        facts: {
          type,
          count: Math.abs(after - before),
          baseline: before,
          faulted: after,
        },
        target: { selector: null, url: null },
      }),
    );
  }
  return observations;
}

export function changedSemanticRegionKeys(baseline: ContentState, faulted: ContentState): string[] {
  const keys = new Set([
    ...Object.keys(baseline.regionFingerprints ?? {}),
    ...Object.keys(faulted.regionFingerprints ?? {}),
  ]);
  const changed = [...keys].filter(
    (key) => baseline.regionFingerprints?.[key] !== faulted.regionFingerprints?.[key],
  );
  const regions = faulted.regions ?? [];
  // An ancestor's text fingerprint naturally changes with its child. Attribute
  // that change to the smallest catalogued semantic owner instead.
  return changed.filter((key) => {
    const outer = regions.find((r) => r.key === key)?.rect;
    if (!outer) return true;
    return !changed.some((other) => {
      if (other === key) return false;
      const inner = regions.find((r) => r.key === other)?.rect;
      return (
        !!inner &&
        inner.x >= outer.x &&
        inner.y >= outer.y &&
        inner.x + inner.width <= outer.x + outer.width &&
        inner.y + inner.height <= outer.y + outer.height &&
        inner.width * inner.height < outer.width * outer.height
      );
    });
  });
}
