/**
 * Runs many fault scenarios concurrently, one isolated browser per scenario.
 *
 * Serial probing is useless for finding loopholes: a page load is ~7s, so
 * testing ten scenarios one at a time costs two minutes. Each scenario also
 * needs its own interceptor state, its own video, and its own before/after
 * primary screenshots, and sharing a page between them would entangle all three.
 * Separate drivers buy that isolation at the cost of a browser launch each,
 * which is roughly a second and overlaps with the others.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import type { Driver } from "../driver/driver";
import type { JourneyError, JourneyErrorKind, JourneyReceipt } from "../journey";
import { createLogger } from "../logging/logger";
import type { FaultAttribution } from "../observers/attribution";
import { captureContentState } from "../observers/content";
import type { FaultReceipt, Scenario } from "../types/chaos";
import type { Evidence, Observation } from "../types/observation";
import type { Result } from "../types/result";
import type { CommonOptions } from "./commands";
import { assembleOutcome } from "./probe-evidence";
import type { ProbeContext, ProbeHooks, ProbeState } from "./probe-outcome";
import {
  captureBaseline,
  cleanNavigation,
  createProbeDriver,
  foreignOrigin,
  foreignOriginOutcome,
  runFault,
  settleProbe,
  throttleDriver,
} from "./probe-outcome";

const _log = createLogger("probe");

export type JourneyFailurePayload = {
  kind: JourneyErrorKind;
  journeyId?: string;
  stepId?: string;
  action?: string;
  receipts: JourneyReceipt[];
};

export type ProbeOutcome = {
  scenario: {
    id: string;
    name: string;
    category: string;
    endpoint: string;
    routeId?: string;
    routePath?: string;
  };
  /** Observations present after the fault that were not there before it. */
  appeared: Observation[];
  disappeared: string[];
  unchangedCount: number;
  receipts: FaultReceipt[];
  matchedCount: number;
  appliedCount: number;
  attributions: FaultAttribution[];
  proof: {
    baselineShot: string | null;
    faultedShot: string | null;
    video: string | null;
    captures?: {
      baseline?: { framing: "viewport"; byteSize?: number };
      faulted?: {
        framing: "viewport" | "region";
        region?: { x: number; y: number; width: number; height: number };
        coordinateSpace?: "viewport-css-px";
        regionId?: string;
        sourceKinds?: string[];
        fallbackReason?: string;
        byteSize?: number;
      };
    };
  };
  /** Set when this scenario could not be evaluated; others still run. */
  error: string | null;
  /** Typed operational failure classification, when applicable. */
  failureKind?: "authentication" | "origin";
  /** Serializable, sanitized journey failure details for CLI reconstruction. */
  journeyFailure?: JourneyFailurePayload;
};

export type ProbeMode = "smoke" | "proof";

export async function probeScenarios(
  opts: CommonOptions,
  scenarios: Scenario[],
  concurrency: number,
  mode: ProbeMode = "proof",
): Promise<ProbeOutcome[]> {
  const results: ProbeOutcome[] = new Array(scenarios.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const scenario = scenarios[index];
      if (!scenario) return;
      results[index] = await probeOne(opts, scenario, index, mode);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker()),
  );
  if (mode === "proof") deduplicateBaselineShots(results, opts.runDir);
  return results;
}

export function isOwnedMedia(path: string, artifactRoot: string): boolean {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      ![".png", ".webm"].includes(extname(path).toLowerCase())
    )
      return false;
    const root = realpathSync(resolve(artifactRoot));
    const owned = realpathSync(path);
    const rel = relative(root, owned);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Keep one canonical baseline image when isolated proof runs rendered the same page. */
export function deduplicateBaselineShots(outcomes: ProbeOutcome[], artifactRoot: string): void {
  const canonical = new Map<string, string>();
  for (const outcome of outcomes) {
    const path = outcome.proof.baselineShot;
    // Untrusted/out-of-root references must never become canonical evidence for
    // an owned run, even when their bytes happen to match an owned screenshot.
    if (!path || !existsSync(path) || !isOwnedMedia(path, artifactRoot)) continue;
    let digest: string;
    try {
      digest = createHash("sha256").update(readFileSync(path)).digest("hex");
    } catch {
      continue;
    }
    const existing = canonical.get(digest);
    if (!existing) {
      canonical.set(digest, path);
      continue;
    }
    if (path === existing) {
      outcome.proof.baselineShot = existing;
      continue;
    }
    try {
      if (!isOwnedMedia(path, artifactRoot)) continue;
      unlinkSync(path);
      outcome.proof.baselineShot = existing;
    } catch {
      // Fail open: retain the duplicate reference if removal fails.
    }
  }
}

export function shotPath(result: Result<Evidence> | null): string | null {
  return result?.ok && result.value.kind === "screenshot" ? result.value.path : null;
}

/** Stable comparison identity: meaningful fact changes on the same target are deltas. */
export function observationFingerprint(o: Observation): string {
  const normalize = (v: unknown): unknown => {
    if (typeof v === "string")
      return v
        .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, "<timestamp>")
        .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<uuid>")
        .replace(/\b\d{6,}\b/g, "<counter>")
        .replace(/\s+/g, " ")
        .trim();
    if (Array.isArray(v)) return v.map(normalize);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, normalize(x)]),
      );
    return v;
  };
  return JSON.stringify({
    kind: o.kind,
    selector: o.target.selector,
    url: o.target.url,
    facts: normalize(o.facts),
  });
}

const SETTLE_SAMPLE_MS = 120;
const SETTLE_STABLE_MS = 750;
const SETTLE_MAX_MS = 3_000;
const TRANSITIONAL_TEXT = /\b(?:loading|authenticating|reconnecting|please\s+wait)\b/i;
function contentSignature(
  state: Awaited<ReturnType<typeof captureContentState>> extends infer R ? R : never,
): string {
  if (!state || !state.ok) return "";
  return JSON.stringify({
    text: state.value.visibleTextLength,
    sample: state.value.textSample,
    elements: state.value.elementCount,
    headings: state.value.headings,
    errors: state.value.errorPhrases,
    spinners: state.value.spinnerCount,
    images: state.value.imageCount,
    links: state.value.linkCount,
    title: state.value.title,
  });
}
export type ContentState = Awaited<ReturnType<typeof captureContentState>>;

function isTransitional(state: ContentState): boolean {
  return (
    !!state &&
    state.ok &&
    (state.value.spinnerCount > 0 || TRANSITIONAL_TEXT.test(state.value.textSample))
  );
}

function settleSample(
  state: ContentState,
  previous: string | null,
  stableSince: number | null,
  now: () => number,
  stableMs: number,
): { previous: string; stableSince: number | null; settled: boolean } | null {
  if (!state || !state.ok) return null;
  const signature = contentSignature(state);
  if (signature !== previous || isTransitional(state))
    return { previous: signature, stableSince: null, settled: false };
  const since = stableSince ?? now();
  return { previous: signature, stableSince: since, settled: now() - since >= stableMs };
}

type SettleOptions = {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  sampleMs?: number;
  stableMs?: number;
  maxMs?: number;
  sample?: (driver: Driver) => ReturnType<typeof captureContentState>;
};

/**
 * Best-effort rendered-state settling. Driver.evaluate has no cancellation
 * primitive. If a production sample exceeds the deadline, this helper returns
 * immediately; the synchronous page evaluation may finish in the background,
 * so callers should treat the resulting screenshot as best-effort.
 */
export async function settleVisibleContent(
  driver: Driver,
  options: SettleOptions = {},
): Promise<void> {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const sampleMs = options.sampleMs ?? SETTLE_SAMPLE_MS;
  const stableMs = options.stableMs ?? SETTLE_STABLE_MS;
  const maxMs = options.maxMs ?? SETTLE_MAX_MS;
  const sample = options.sample ?? captureContentState;
  const deadline = now() + maxMs;
  let previous: string | null = null;
  let stableSince: number | null = null;
  while (now() < deadline) {
    const remaining = Math.max(1, deadline - now());
    // Injected samples are deterministic test seams; production samples get a
    // real timeout so a hung evaluate cannot extend this helper indefinitely.
    const sampleResult = options.sample
      ? await sample(driver)
      : await Promise.race([
          sample(driver),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), remaining)),
        ]);
    if (sampleResult === null) return;
    const progress = settleSample(sampleResult, previous, stableSince, now, stableMs);
    if (progress?.settled) return;
    if (progress) ({ previous, stableSince } = progress);
    await sleep(Math.min(sampleMs, Math.max(0, deadline - now())));
  }
}

export function describe(scenario: Scenario, opts?: CommonOptions): ProbeOutcome["scenario"] {
  return {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    endpoint: `${scenario.endpoint.method} ${scenario.endpoint.pattern}`,
    ...(opts?.route ? { routeId: opts.route.id, routePath: opts.route.path } : {}),
  };
}

export function journeyFailurePayload(error: JourneyError): JourneyFailurePayload {
  return {
    kind: error.kind,
    ...(error.journeyId ? { journeyId: error.journeyId } : {}),
    ...(error.stepId ? { stepId: error.stepId } : {}),
    ...(error.action ? { action: error.action } : {}),
    receipts: error.receipts
      .filter((receipt) => receipt.status === "completed")
      .map(({ journeyId, stepId, type, status, checkpointId }) => ({
        journeyId,
        stepId,
        type,
        status,
        ...(checkpointId ? { checkpointId } : {}),
      })),
  };
}

function emptyProbeOutcome(
  scenario: Scenario,
  opts: CommonOptions,
  error: string | null,
  proof?: Partial<ProbeOutcome["proof"]>,
  failureKind?: ProbeOutcome["failureKind"],
  failure?: JourneyFailurePayload,
): ProbeOutcome {
  return {
    scenario: describe(scenario, opts),
    appeared: [],
    disappeared: [],
    unchangedCount: 0,
    receipts: [],
    matchedCount: 0,
    appliedCount: 0,
    attributions: [],
    proof: { baselineShot: null, faultedShot: null, video: null, ...proof },
    error,
    ...(failureKind ? { failureKind } : {}),
    ...(failure ? { journeyFailure: failure } : {}),
  };
}

async function probeOneWorkflow(
  opts: CommonOptions,
  scenario: Scenario,
  index: number,
  mode: ProbeMode = "proof",
  driverOverride?: Driver,
  hooks: ProbeHooks = {},
): Promise<ProbeOutcome> {
  const context: ProbeContext = {
    opts,
    scenario,
    mode,
    hooks,
    artifactDir: join(opts.runDir, `s${String(index + 1).padStart(2, "0")}`),
    empty: (error, proof, kind, failure) =>
      emptyProbeOutcome(scenario, opts, error, proof, kind, failure),
  };
  const created = await createProbeDriver(context, driverOverride);
  if (!created.ok) return context.empty(created.error.message);
  let state: ProbeState = {
    driver: created.value,
    fingerprintKey: "",
    baselineContent: null,
    baseline: [],
    baselineShot: null,
    receipts: [],
  };
  try {
    const throttled = await throttleDriver(context, state.driver);
    if (throttled.outcome) return throttled.outcome;
    const navigation = await cleanNavigation(context, state.driver);
    if (navigation.outcome) return navigation.outcome;
    state = await captureBaseline(context, state.driver);
    const fault = await runFault(context, state);
    if (fault.outcome) return fault.outcome;
    await state.driver.waitForIdle();
    if (foreignOrigin(context, state.driver)) return foreignOriginOutcome(context, state);
    await settleProbe(context, state.driver);
    const outcome = await assembleOutcome(context, state);
    return outcome;
  } finally {
    await state.driver.close();
  }
}

export async function probeOne(
  opts: CommonOptions,
  scenario: Scenario,
  index: number,
  mode: ProbeMode = "proof",
  driverOverride?: Driver,
  hooks: Parameters<typeof probeOneWorkflow>[5] = {},
): Promise<ProbeOutcome> {
  return probeOneWorkflow(opts, scenario, index, mode, driverOverride, hooks);
}
