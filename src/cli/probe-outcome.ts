import { randomBytes } from "node:crypto";
import { authGuard, navigationGuard } from "../auth/guard";
import { cpuRateFor } from "../capture/cpu-profiles";
import { coarsePatternFor, presetInterceptor, scenarioInterceptor } from "../chaos/interceptor";
import type { Driver } from "../driver/driver";
import { createPlaywrightDriver } from "../driver/playwright";
import { JourneyError, type JourneyFile, runJourney } from "../journey";
import { createLogger } from "../logging/logger";
import { captureContentState } from "../observers/content";
import { runObserver } from "../observers/observer";
import { visualObserver } from "../observers/visual";
import type { FaultReceipt, Scenario } from "../types/chaos";
import { createObservation, type Evidence, type Observation } from "../types/observation";
import type { Result } from "../types/result";
import type { CommonOptions } from "./commands";
import type { JourneyFailurePayload, ProbeMode, ProbeOutcome } from "./probe";
import { type ContentState, journeyFailurePayload, settleVisibleContent, shotPath } from "./probe";

const _log = createLogger("probe");

export type ProbeHooks = {
  settle?: (driver: Driver) => Promise<void>;
  observe?: (driver: Driver) => Promise<Observation[]>;
  content?: (driver: Driver) => ReturnType<typeof captureContentState>;
  createDriver?: typeof createPlaywrightDriver;
};

export type ProbeContext = {
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

export type ProbeState = {
  driver: Driver;
  fingerprintKey: string;
  baselineContent: ContentState | null;
  baseline: Observation[];
  baselineShot: Result<Evidence> | null;
  reloaded?: Result<unknown>;
  receipts: FaultReceipt[];
};

export type ProbeStep = { outcome?: ProbeOutcome };

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

export async function createProbeDriver(context: ProbeContext, override?: Driver) {
  if (override) return { ok: true, value: override } as const;
  return (context.hooks.createDriver ?? createPlaywrightDriver)(driverOptions(context));
}

export async function throttleDriver(context: ProbeContext, driver: Driver): Promise<ProbeStep> {
  if (!context.opts.cpu) return {};
  const result = await driver.emulateCpuThrottle(cpuRateFor(context.opts.cpu));
  return result.ok ? {} : { outcome: context.empty(result.error.message) };
}

export async function cleanNavigation(context: ProbeContext, driver: Driver): Promise<ProbeStep> {
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

export async function settleProbe(context: ProbeContext, driver: Driver): Promise<void> {
  await driver.waitForIdle();
  if (context.mode !== "proof") return;
  await (context.hooks.settle ? context.hooks.settle(driver) : settleVisibleContent(driver));
}

export async function observeProbe(context: ProbeContext, driver: Driver): Promise<Observation[]> {
  if (context.mode !== "proof") return [];
  if (context.hooks.observe) return context.hooks.observe(driver);
  return (
    await runObserver(visualObserver, { driver, url: context.opts.url, captureEvidence: false })
  ).observations;
}

export async function captureContent(context: ProbeContext, driver: Driver, key: string) {
  return context.hooks.content ? context.hooks.content(driver) : captureContentState(driver, key);
}

export async function captureBaseline(context: ProbeContext, driver: Driver): Promise<ProbeState> {
  await settleProbe(context, driver);
  const fingerprintKey = randomBytes(32).toString("hex");
  const baselineContent = await captureContent(context, driver, fingerprintKey);
  const baseline = await observeProbe(context, driver);
  const baselineShot =
    context.mode === "proof" ? await driver.screenshot({ label: "baseline" }) : null;
  return { driver, fingerprintKey, baselineContent, baseline, baselineShot, receipts: [] };
}

export function createInterceptor(context: ProbeContext) {
  const { scenario, opts } = context;
  return scenario.preset
    ? presetInterceptor(scenario.preset, {
        scenarioId: scenario.id,
        targetOrigin: new URL(opts.url).origin,
        seed: opts.seed,
      })
    : scenarioInterceptor(scenario);
}

export async function runJourneyFault(
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

export function journeyFaultResult(
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

export async function runReloadFault(context: ProbeContext, state: ProbeState): Promise<ProbeStep> {
  const installed = await state.driver.intercept(createInterceptor(context), {
    urlPattern: coarsePatternFor(context.scenario),
  });
  if (!installed.ok) return { outcome: context.empty(installed.error.message) };
  state.reloaded = await state.driver.reload({ waitUntil: context.opts.waitUntil });
  return {};
}

export async function runFault(context: ProbeContext, state: ProbeState): Promise<ProbeStep> {
  const journey = context.opts.journey;
  return journey ? runJourneyFault(context, state, journey) : runReloadFault(context, state);
}

export function foreignOrigin(context: ProbeContext, driver: Driver): boolean {
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

export function receiptCounts(receipts: FaultReceipt[], separator: string) {
  const count = (statuses: string[]) =>
    new Set(
      receipts
        .filter((receipt) => statuses.includes(receipt.status))
        .map((receipt) => `${receipt.method}${separator}${receipt.url}`),
    ).size;
  return { matchedCount: count(["matched", "applied"]), appliedCount: count(["applied"]) };
}

export async function foreignOriginOutcome(
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

export function drainReceipts(context: ProbeContext, driver: Driver): FaultReceipt[] {
  return driver
    .drainFaultReceipts()
    .map((receipt) => normalizeJourneyReceipt(context, receipt))
    .map((receipt) => addRoute(context, receipt));
}

export function requireReload(state: ProbeState): Result<unknown> {
  if (!state.reloaded) throw new Error("probe fault result is missing");
  return state.reloaded;
}
