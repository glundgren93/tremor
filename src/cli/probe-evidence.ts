import { createLogger } from "../logging/logger";
import { attributeFaults } from "../observers/attribution";
import {
  type captureContentState,
  changedSemanticRegionKeys,
  diffContent,
} from "../observers/content";
import { selectTrustedRegion } from "../observers/regions";
import type { Evidence } from "../types/observation";
import type { Result } from "../types/result";
import type { ProbeOutcome } from "./probe";
import { describe, observationFingerprint, shotPath } from "./probe";
import {
  captureContent,
  drainReceipts,
  observeProbe,
  type ProbeContext,
  type ProbeState,
  receiptCounts,
  requireReload,
} from "./probe-outcome";

const log = createLogger("probe");
type ContentState = Awaited<ReturnType<typeof captureContentState>>;
async function captureFaultData(context: ProbeContext, state: ProbeState) {
  const reloaded = requireReload(state);
  state.receipts = drainReceipts(context, state.driver);
  const after = reloaded.ok ? await observeProbe(context, state.driver) : [];
  const faultedContent = reloaded.ok
    ? await captureContent(context, state.driver, state.fingerprintKey)
    : null;
  const baselineContent = state.baselineContent;
  if (!baselineContent?.ok || !faultedContent?.ok)
    return { after, faultedContent, contentDelta: [], attributions: [] };
  return {
    after,
    faultedContent,
    contentDelta: diffContent(baselineContent.value, faultedContent.value),
    attributions: attributeFaults(state.receipts, baselineContent.value, faultedContent.value),
  };
}

function captureChoice(state: ProbeState, faultedContent: ContentState | null) {
  if (!state.reloaded?.ok) return { fallbackReason: "reload-failed" } as const;
  const baselineContent = state.baselineContent;
  if (!baselineContent?.ok || !faultedContent?.ok)
    return { fallbackReason: "semantic-state-unavailable" } as const;
  return selectTrustedRegion(
    baselineContent.value.regions ?? [],
    faultedContent.value.regions ?? [],
    changedSemanticRegionKeys(baselineContent.value, faultedContent.value),
  );
}

async function captureFinalShot(
  context: ProbeContext,
  state: ProbeState,
  choice: ReturnType<typeof captureChoice>,
) {
  if (context.mode !== "proof") return null;
  let shot =
    "region" in choice
      ? await state.driver.screenshot({ label: "faulted-final", region: choice.region })
      : await state.driver.screenshot({ label: "faulted-final" });
  if (!shot.ok && "region" in choice)
    shot = await state.driver.screenshot({ label: "faulted-final" });
  return shot;
}

function faultedCapture(shot: Result<Evidence> | null, choice: ReturnType<typeof captureChoice>) {
  if (!shot?.ok || shot.value.kind !== "screenshot") return {};
  const value = shot.value;
  return {
    faulted: {
      framing: value.framing === "region" ? ("region" as const) : ("viewport" as const),
      ...(value.region
        ? { region: value.region, coordinateSpace: "viewport-css-px" as const }
        : {}),
      ...(value.framing === "region" && "region" in choice
        ? { regionId: choice.regionId, sourceKinds: choice.sourceKinds }
        : {}),
      ...(value.framing !== "region"
        ? {
            fallbackReason:
              "fallbackReason" in choice ? choice.fallbackReason : "regional-capture-failed",
          }
        : {}),
      byteSize: value.byteSize,
    },
  };
}

export async function assembleOutcome(
  context: ProbeContext,
  state: ProbeState,
): Promise<ProbeOutcome> {
  const reloaded = requireReload(state);
  const data = await captureFaultData(context, state);
  const choice = captureChoice(state, data.faultedContent);
  const faultedShot = await captureFinalShot(context, state, choice);
  const key = observationFingerprint;
  const before = new Set(state.baseline.map(key));
  const now = new Set(data.after.map(key));
  const appeared = [...data.after.filter((item) => !before.has(key(item))), ...data.contentDelta];
  log.info(
    { scenario: context.scenario.name, appeared: appeared.length, navOk: reloaded.ok },
    "scenario probed",
  );
  return {
    scenario: describe(context.scenario, context.opts),
    appeared,
    disappeared: state.baseline.filter((item) => !now.has(key(item))).map((item) => item.summary),
    unchangedCount: data.after.length - (appeared.length - data.contentDelta.length),
    receipts: state.receipts,
    ...receiptCounts(state.receipts, "\0"),
    attributions: data.attributions,
    proof: await assembleProof(state, faultedShot, choice),
    error: reloaded.ok ? null : `page did not load under fault: ${reloaded.error.message}`,
  };
}

async function assembleProof(
  state: ProbeState,
  faultedShot: Result<Evidence> | null,
  choice: ReturnType<typeof captureChoice>,
): Promise<ProbeOutcome["proof"]> {
  const baseline =
    state.baselineShot?.ok && state.baselineShot.value.kind === "screenshot"
      ? { baseline: { framing: "viewport" as const, byteSize: state.baselineShot.value.byteSize } }
      : {};
  return {
    baselineShot: shotPath(state.baselineShot),
    faultedShot: shotPath(faultedShot),
    video: await state.driver.recordingPath(),
    captures: { ...baseline, ...faultedCapture(faultedShot, choice) },
  };
}
