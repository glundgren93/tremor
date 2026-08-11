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

import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, unlinkSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { authGuard, navigationGuard } from "../auth/guard";
import { cpuRateFor } from "../capture/cpu-profiles";
import { coarsePatternFor, presetInterceptor, scenarioInterceptor } from "../chaos/interceptor";
import type { Driver } from "../driver/driver";
import { createPlaywrightDriver } from "../driver/playwright";
import {
  JourneyError,
  type JourneyErrorKind,
  type JourneyFile,
  type JourneyReceipt,
  runJourney,
} from "../journey";
import { createLogger } from "../logging/logger";
import { attributeFaults, type FaultAttribution } from "../observers/attribution";
import { captureContentState, changedSemanticRegionKeys, diffContent } from "../observers/content";
import { runObserver } from "../observers/observer";
import { selectTrustedRegion } from "../observers/regions";
import { visualObserver } from "../observers/visual";
import type { FaultReceipt, Scenario } from "../types/chaos";
import { createObservation, type Evidence, type Observation } from "../types/observation";
import type { Result } from "../types/result";
import type { CommonOptions } from "./commands";

const log = createLogger("probe");

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

function shotPath(result: Result<Evidence> | null): string | null {
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
type ContentState = Awaited<ReturnType<typeof captureContentState>>;

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

function describe(scenario: Scenario, opts?: CommonOptions): ProbeOutcome["scenario"] {
  return {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    endpoint: `${scenario.endpoint.method} ${scenario.endpoint.pattern}`,
    ...(opts?.route ? { routeId: opts.route.id, routePath: opts.route.path } : {}),
  };
}

function journeyFailurePayload(error: JourneyError): JourneyFailurePayload {
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

type ProbeHooks = {
  settle?: (driver: Driver) => Promise<void>;
  observe?: (driver: Driver) => Promise<Observation[]>;
  content?: (driver: Driver) => ReturnType<typeof captureContentState>;
  createDriver?: typeof createPlaywrightDriver;
};

type ProbeContext = {
  opts: CommonOptions;
  scenario: Scenario;
  mode: ProbeMode;
  hooks: ProbeHooks;
  artifactDir: string;
  empty: (
    error: string | null,
    proof?: Partial<ProbeOutcome["proof"]>,
    failureKind?: ProbeOutcome["failureKind"],
    failure?: JourneyFailurePayload,
  ) => ProbeOutcome;
};

type ProbeState = {
  driver: Driver;
  fingerprintKey: string;
  baselineContent: ContentState | null;
  baseline: Observation[];
  baselineShot: Result<Evidence> | null;
  reloaded?: Result<unknown>;
  receipts: FaultReceipt[];
};

type ProbeStep = { outcome?: ProbeOutcome };

function driverOptions(context: ProbeContext, journeyFault = false) {
  const { opts, mode, artifactDir } = context;
  return {
    url: opts.url,
    headless: opts.headless,
    artifactDir,
    viewport: opts.viewport,
    timeoutMs: opts.timeoutMs,
    recordVideo: mode === "proof" && opts.video && (journeyFault || !opts.journey),
    storageStatePath: opts.authState,
  };
}

async function createProbeDriver(context: ProbeContext, override?: Driver) {
  if (override) return { ok: true, value: override } as const;
  return (context.hooks.createDriver ?? createPlaywrightDriver)(driverOptions(context));
}

async function throttleDriver(context: ProbeContext, driver: Driver): Promise<ProbeStep> {
  if (!context.opts.cpu) return {};
  const result = await driver.emulateCpuThrottle(cpuRateFor(context.opts.cpu));
  return result.ok ? {} : { outcome: context.empty(result.error.message) };
}

async function cleanNavigation(context: ProbeContext, driver: Driver): Promise<ProbeStep> {
  const { opts, scenario } = context;
  const nav = opts.journey
    ? await runJourney(driver, opts.journey, opts.url, {
        navigate: { waitUntil: opts.waitUntil },
        authGuard: () => authGuard(opts.url, driver.currentUrl(), opts.authSelection),
        stopAtCheckpoint: scenario.checkpointId,
      })
    : await driver.navigate(opts.url, { waitUntil: opts.waitUntil });
  if (nav.ok) return guardCleanOrigin(context, driver);
  return { outcome: navigationFailure(context, nav.error) };
}

function navigationFailure(context: ProbeContext, error: Error): ProbeOutcome {
  const authentication = error instanceof JourneyError && error.kind === "authentication";
  return context.empty(
    error.message,
    undefined,
    authentication ? "authentication" : undefined,
    authentication ? journeyFailurePayload(error) : undefined,
  );
}

function guardCleanOrigin(context: ProbeContext, driver: Driver): ProbeStep {
  const { opts } = context;
  const guard = navigationGuard(opts.url, driver.currentUrl(), opts.authSelection);
  return guard.ok
    ? {}
    : { outcome: context.empty(guard.message, undefined, guard.kind ?? "origin") };
}

async function settleProbe(context: ProbeContext, driver: Driver): Promise<void> {
  await driver.waitForIdle();
  if (context.mode !== "proof") return;
  await (context.hooks.settle ? context.hooks.settle(driver) : settleVisibleContent(driver));
}

async function observeProbe(context: ProbeContext, driver: Driver): Promise<Observation[]> {
  if (context.mode !== "proof") return [];
  if (context.hooks.observe) return context.hooks.observe(driver);
  return (
    await runObserver(visualObserver, { driver, url: context.opts.url, captureEvidence: false })
  ).observations;
}

async function captureContent(context: ProbeContext, driver: Driver, key: string) {
  return context.hooks.content ? context.hooks.content(driver) : captureContentState(driver, key);
}

async function captureBaseline(context: ProbeContext, driver: Driver): Promise<ProbeState> {
  await settleProbe(context, driver);
  const fingerprintKey = randomBytes(32).toString("hex");
  const baselineContent = await captureContent(context, driver, fingerprintKey);
  const baseline = await observeProbe(context, driver);
  const baselineShot =
    context.mode === "proof" ? await driver.screenshot({ label: "baseline" }) : null;
  return { driver, fingerprintKey, baselineContent, baseline, baselineShot, receipts: [] };
}

function createInterceptor(context: ProbeContext) {
  const { scenario, opts } = context;
  return scenario.preset
    ? presetInterceptor(scenario.preset, {
        scenarioId: scenario.id,
        targetOrigin: new URL(opts.url).origin,
        seed: opts.seed,
      })
    : scenarioInterceptor(scenario);
}

async function runJourneyFault(
  context: ProbeContext,
  state: ProbeState,
  journey: JourneyFile,
): Promise<ProbeStep> {
  const { opts, scenario } = context;
  await state.driver.close();
  const created = await (context.hooks.createDriver ?? createPlaywrightDriver)(
    driverOptions(context, true),
  );
  if (!created.ok) return { outcome: context.empty(created.error.message) };
  state.driver = created.value;
  const throttled = await throttleDriver(context, state.driver);
  if (throttled.outcome) return throttled;
  let armed = false;
  state.reloaded = await runJourney(state.driver, journey, opts.url, {
    navigate: { waitUntil: opts.waitUntil },
    authGuard: () => authGuard(opts.url, state.driver.currentUrl(), opts.authSelection),
    stopAtCheckpoint: scenario.checkpointId,
    beforeStep: async (step) => {
      if (armed || step.id !== scenario.observedStepId) return;
      const installed = await state.driver.intercept(createInterceptor(context), {
        urlPattern: coarsePatternFor(scenario),
      });
      if (!installed.ok) throw new Error("fault interceptor could not be installed");
      armed = true;
    },
  });
  return journeyFaultResult(context, state.reloaded, armed);
}

function journeyFaultResult(
  context: ProbeContext,
  result: Result<unknown>,
  armed: boolean,
): ProbeStep {
  if (
    !result.ok &&
    !armed &&
    result.error instanceof JourneyError &&
    result.error.kind === "authentication"
  ) {
    return {
      outcome: context.empty(
        result.error.message,
        undefined,
        "authentication",
        journeyFailurePayload(result.error),
      ),
    };
  }
  return armed ? {} : { outcome: context.empty("journey scenario step was not reached") };
}

async function runReloadFault(context: ProbeContext, state: ProbeState): Promise<ProbeStep> {
  const installed = await state.driver.intercept(createInterceptor(context), {
    urlPattern: coarsePatternFor(context.scenario),
  });
  if (!installed.ok) return { outcome: context.empty(installed.error.message) };
  state.reloaded = await state.driver.reload({ waitUntil: context.opts.waitUntil });
  return {};
}

async function runFault(context: ProbeContext, state: ProbeState): Promise<ProbeStep> {
  const journey = context.opts.journey;
  return journey ? runJourneyFault(context, state, journey) : runReloadFault(context, state);
}

function foreignOrigin(context: ProbeContext, driver: Driver): boolean {
  try {
    return new URL(driver.currentUrl()).origin !== new URL(context.opts.url).origin;
  } catch {
    return true;
  }
}

function addRoute(context: ProbeContext, receipt: FaultReceipt): FaultReceipt {
  return {
    ...receipt,
    ...(context.opts.route
      ? { routeId: context.opts.route.id, routePath: context.opts.route.path }
      : {}),
  };
}

function receiptCounts(receipts: FaultReceipt[], separator: string) {
  const count = (statuses: string[]) =>
    new Set(
      receipts
        .filter((receipt) => statuses.includes(receipt.status))
        .map((receipt) => `${receipt.method}${separator}${receipt.url}`),
    ).size;
  return { matchedCount: count(["matched", "applied"]), appliedCount: count(["applied"]) };
}

async function foreignOriginOutcome(
  context: ProbeContext,
  state: ProbeState,
): Promise<ProbeOutcome> {
  const receipts = state.driver.drainFaultReceipts().map((receipt) => addRoute(context, receipt));
  return {
    ...context.empty(null, {
      baselineShot: shotPath(state.baselineShot),
      faultedShot: null,
      video: await state.driver.recordingPath(),
    }),
    appeared: [
      createObservation({
        kind: "navigation.origin-changed",
        summary: "Navigation left the expected origin under fault.",
        facts: { changed: true },
        target: { selector: null, url: null },
      }),
    ],
    receipts,
    ...receiptCounts(receipts, " "),
  };
}

function normalizeJourneyReceipt(context: ProbeContext, receipt: FaultReceipt): FaultReceipt {
  if (!context.opts.journey) return receipt;
  const value = new URL(receipt.url);
  return {
    ...receipt,
    url: `${value.origin}${value.pathname}`,
    journeyId: context.opts.journey.id,
    checkpointId: context.scenario.checkpointId,
    observedStepId: context.scenario.observedStepId,
  };
}

function drainReceipts(context: ProbeContext, driver: Driver): FaultReceipt[] {
  return driver
    .drainFaultReceipts()
    .map((receipt) => normalizeJourneyReceipt(context, receipt))
    .map((receipt) => addRoute(context, receipt));
}

function requireReload(state: ProbeState): Result<unknown> {
  if (!state.reloaded) throw new Error("probe fault result is missing");
  return state.reloaded;
}

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

async function assembleOutcome(context: ProbeContext, state: ProbeState): Promise<ProbeOutcome> {
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
