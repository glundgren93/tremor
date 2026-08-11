import { unlinkSync } from "node:fs";
import { JourneyError } from "../journey";
import { isOwnedMedia, type ProbeOutcome } from "./probe";
export function authenticationError(outcome: ProbeOutcome): Error {
  const failure = outcome.journeyFailure;
  if (!failure || !outcome.error) return new Error(outcome.error ?? "Authentication failed");
  return new JourneyError(
    failure.kind,
    failure.stepId,
    failure.action,
    outcome.error,
    failure.receipts,
    failure.journeyId,
  );
}

/** A preset rendered as a scenario so one probe path handles both. */
export function selectProofCandidates(
  outcomes: ProbeOutcome[],
  limit: number,
): { outcome: ProbeOutcome; index: number }[] {
  if (limit <= 0) return [];
  return outcomes
    .map((outcome, index) => ({ outcome, index }))
    .filter(
      ({ outcome }) =>
        outcome.appliedCount > 0 &&
        (outcome.appeared.length > 0 || outcome.disappeared.length > 0) &&
        !outcome.error &&
        !outcome.receipts.some((receipt) => receipt.status === "error"),
    )
    .slice(0, limit);
}

export function mergeProofArtifacts(
  outcomes: ProbeOutcome[],
  candidates: { index: number }[],
  proof: ProbeOutcome[],
  artifactRoot: string,
): void {
  const meaningful = (rerun: ProbeOutcome | undefined, smoke: ProbeOutcome | undefined) =>
    !!smoke &&
    !!rerun &&
    !rerun.error &&
    !!rerun.proof.baselineShot &&
    !!rerun.proof.faultedShot &&
    rerun.appliedCount > 0 &&
    (rerun.appeared.length > 0 || rerun.disappeared.length > 0) &&
    !rerun.receipts.some((r) => r.status === "error");
  // Deduplication may make a rejected rerun point at an accepted scenario's file.
  // Establish protected canonical paths before deleting anything.
  const protectedBaselines = new Set(
    proof
      .filter((rerun, i) => meaningful(rerun, outcomes[candidates[i]?.index ?? -1]))
      .map((rerun) => rerun.proof.baselineShot)
      .filter((path): path is string => !!path),
  );

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const smoke = outcomes[candidate.index];
    const rerun = proof[i];
    if (!meaningful(rerun, smoke)) {
      if (rerun) removeProvisionalProofArtifacts(rerun, artifactRoot, protectedBaselines);
      continue;
    }
    if (smoke && rerun) {
      // Accepted settled evidence must move as one coherent set. Retain only
      // scenario identity from the smoke run.
      smoke.appeared = rerun.appeared;
      smoke.disappeared = rerun.disappeared;
      smoke.unchangedCount = rerun.unchangedCount;
      smoke.receipts = rerun.receipts;
      smoke.matchedCount = rerun.matchedCount;
      smoke.appliedCount = rerun.appliedCount;
      smoke.attributions = rerun.attributions;
      smoke.proof = rerun.proof;
    }
  }
}

/** Remove all rerun-owned media, preserving a deduplicated accepted baseline. */
export function removeProvisionalProofArtifacts(
  outcome: ProbeOutcome,
  artifactRoot: string,
  protectedBaselines: ReadonlySet<string> = new Set(),
): void {
  for (const path of [outcome.proof.baselineShot, outcome.proof.faultedShot, outcome.proof.video]) {
    if (!path || protectedBaselines.has(path) || !isOwnedMedia(path, artifactRoot)) continue;
    try {
      unlinkSync(path);
    } catch {}
  }
  outcome.proof = { baselineShot: null, faultedShot: null, video: null };
}
