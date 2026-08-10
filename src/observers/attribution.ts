import type { FaultReceipt } from "../types/chaos";
import type { ContentState } from "./content";
import { changedSemanticRegionKeys } from "./content";
import type { RegionMetrics, SemanticRegion } from "./regions";

export type ReceiptReference = {
  receiptIndex: number;
  scenarioId: string;
  faultId: string;
  method: string;
  timestamp: number;
};

export type RegionMetricDelta = {
  regionId: string;
  kind: string;
  before: RegionMetrics;
  after: RegionMetrics;
  changedFields: (keyof RegionMetrics | "textContent")[];
};

/** Versioned, factual receipt-to-rendered-region comparison. */
export type FaultAttribution = {
  version: 1;
  receipt: ReceiptReference;
  status: "attributed" | "ambiguous" | "no-region-delta";
  reason: string;
  evidence: {
    basis: "isolated-fault-state-comparison";
    appliedReceiptCount: number;
    changedTrustedRegionCount: number;
  };
  regionDeltas: RegionMetricDelta[];
};

const metricKeys: (keyof RegionMetrics)[] = [
  "textLength",
  "rowCount",
  "itemCount",
  "controlCount",
  "errorPhraseCount",
  "skeletonCount",
  "blankCount",
];

const iou = (a: SemanticRegion["rect"], b: SemanticRegion["rect"]): number => {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const intersection = width * height;
  const denominator = a.width * a.height + b.width * b.height - intersection;
  return Number.isFinite(denominator) && denominator > 0 ? intersection / denominator : 0;
};

function trustedDelta(
  key: string,
  baseline: ContentState,
  faulted: ContentState,
): RegionMetricDelta | null {
  const beforeMatches = (baseline.regions ?? []).filter((region) => region.key === key);
  const afterMatches = (faulted.regions ?? []).filter((region) => region.key === key);
  const before = beforeMatches[0];
  const after = afterMatches[0];
  if (
    beforeMatches.length !== 1 ||
    afterMatches.length !== 1 ||
    !before ||
    !after ||
    before.count !== 1 ||
    after.count !== 1 ||
    before.kind === "body" ||
    after.kind === "body" ||
    before.kind !== after.kind ||
    before.regionId !== after.regionId ||
    before.viewport.width !== after.viewport.width ||
    before.viewport.height !== after.viewport.height ||
    [
      before.viewport.width,
      before.viewport.height,
      after.viewport.width,
      after.viewport.height,
    ].some((value) => !Number.isFinite(value) || value <= 0) ||
    !before.metrics ||
    !after.metrics ||
    [before, after].some(
      (region) =>
        !Number.isFinite(region.visibleRatio) ||
        region.visibleRatio < 0.95 ||
        region.rect.width < 32 ||
        region.rect.height < 32 ||
        !Object.values(region.rect).every(Number.isFinite),
    ) ||
    iou(before.rect, after.rect) < 0.75
  )
    return null;
  const changedFields: RegionMetricDelta["changedFields"] = metricKeys.filter(
    (field) => before.metrics?.[field] !== after.metrics?.[field],
  );
  if (baseline.regionTextFingerprints?.[key] !== faulted.regionTextFingerprints?.[key])
    changedFields.push("textContent");
  if (changedFields.length === 0) return null;
  return {
    regionId: after.regionId,
    kind: after.kind,
    before: before.metrics,
    after: after.metrics,
    changedFields,
  };
}

/** Pure deterministic fail-closed attribution; receipt timing is never used as evidence. */
export function attributeFaults(
  receipts: FaultReceipt[],
  baseline: ContentState,
  faulted: ContentState,
): FaultAttribution[] {
  const applied = receipts
    .map((receipt, receiptIndex) => ({ receipt, receiptIndex }))
    .filter(({ receipt }) => receipt.status === "applied");
  if (applied.length === 0) return [];

  const changedKeys = changedSemanticRegionKeys(baseline, faulted);
  const deltas = changedKeys
    .map((key) => trustedDelta(key, baseline, faulted))
    .filter((delta): delta is RegionMetricDelta => delta !== null)
    .sort((a, b) => a.regionId.localeCompare(b.regionId));
  const allTrusted = changedKeys.length > 0 && deltas.length === changedKeys.length;

  return applied.map(({ receipt, receiptIndex }) => {
    const reference = {
      receiptIndex,
      scenarioId: receipt.scenarioId,
      faultId: receipt.faultId,
      method: receipt.method,
      timestamp: receipt.timestamp,
    };
    const evidence = {
      basis: "isolated-fault-state-comparison" as const,
      appliedReceiptCount: applied.length,
      changedTrustedRegionCount: allTrusted ? deltas.length : 0,
    };
    if (applied.length > 1)
      return {
        version: 1,
        receipt: reference,
        status: "ambiguous",
        reason:
          "Multiple applied receipts prevent distinguishing an individual request-to-region mapping.",
        evidence,
        regionDeltas: [],
      };
    if (!allTrusted)
      return {
        version: 1,
        receipt: reference,
        status: "no-region-delta",
        reason: changedKeys.length
          ? "Changed semantic region identity, visibility, metrics, or geometry was not uniquely stable."
          : "No changed trusted semantic region was observed.",
        evidence,
        regionDeltas: [],
      };
    return {
      version: 1,
      receipt: reference,
      status: "attributed",
      reason: `One applied receipt was compared with ${deltas.length} changed trusted semantic region(s) in the isolated fault state.`,
      evidence,
      regionDeltas: deltas,
    };
  });
}
