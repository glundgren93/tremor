import { unlinkSync } from "node:fs";
import { type AuthSelection, authGuard } from "../auth/guard";
import { scan } from "../capture/capture";
import { type CpuProfile, cpuRateFor } from "../capture/cpu-profiles";
import { PRESETS } from "../chaos/presets";
import type { Driver, WaitUntil } from "../driver/driver";
import { createPlaywrightDriver } from "../driver/playwright";
import { JourneyError, type JourneyFile, type JourneyReceipt } from "../journey";
import { runObserver } from "../observers/observer";
import { visualObserver } from "../observers/visual";
import type { ChaosPreset, Endpoint, Scenario } from "../types/chaos";
import type { Observation, ObservationSet } from "../types/observation";
import { err, ok, type Result } from "../types/result";
import { isOwnedMedia, type ProbeOutcome, probeScenarios } from "./probe";

export type CommonOptions = {
  url: string;
  runDir: string;
  headless: boolean;
  waitUntil: WaitUntil;
  timeoutMs: number;
  viewport: { width: number; height: number };
  video: boolean;
  cpu?: CpuProfile;
  authState?: string;
  authSelection?: AuthSelection;
  seed?: string;
  journey?: JourneyFile;
};

const OBSERVERS = [visualObserver];

async function withDriver<T>(
  opts: CommonOptions,
  fn: (driver: Driver) => Promise<Result<T>>,
): Promise<Result<T & { videoPath: string | null }>> {
  const created = await createPlaywrightDriver({
    url: opts.url,
    headless: opts.headless,
    artifactDir: opts.runDir,
    viewport: opts.viewport,
    timeoutMs: opts.timeoutMs,
    recordVideo: opts.video,
    storageStatePath: opts.authState,
  });
  if (!created.ok) return created;

  const driver = created.value;
  try {
    if (opts.cpu) {
      const throttled = await driver.emulateCpuThrottle(cpuRateFor(opts.cpu));
      if (!throttled.ok) return throttled;
    }
    const result = await fn(driver);
    if (!result.ok) return result;
    const videoPath = await driver.recordingPath();
    return ok({ ...result.value, videoPath });
  } finally {
    await driver.close();
  }
}

export type ScenarioCategory = Scenario["category"];

export type ScanOutput = {
  endpoints: Endpoint[];
  scenarios: Scenario[];
  exchangeCount: number;
  journey?: { id: string; receipts: JourneyReceipt[] };
};

export function commandScan(opts: CommonOptions, filter?: string) {
  return withDriver(opts, async (driver) => {
    const replayCreated = opts.journey
      ? await createPlaywrightDriver({
          url: opts.url,
          headless: opts.headless,
          artifactDir: opts.runDir,
          viewport: opts.viewport,
          timeoutMs: opts.timeoutMs,
          recordVideo: false,
          storageStatePath: opts.authState,
        })
      : undefined;
    if (replayCreated && !replayCreated.ok) return replayCreated;
    const replayDriver = replayCreated?.ok ? replayCreated.value : undefined;
    if (replayDriver && opts.cpu) {
      const throttled = await replayDriver.emulateCpuThrottle(cpuRateFor(opts.cpu));
      if (!throttled.ok) {
        await replayDriver.close();
        return throttled;
      }
    }
    let result: Awaited<ReturnType<typeof scan>>;
    try {
      result = await scan(driver, {
        url: opts.url,
        filter,
        navigate: { waitUntil: opts.waitUntil },
        scenarios: { seed: opts.seed },
        journey: opts.journey,
        replay: Boolean(opts.journey),
        replayDriver,
        authGuard: (activeDriver) =>
          authGuard(opts.url, activeDriver.currentUrl(), opts.authSelection),
      });
    } finally {
      await replayDriver?.close();
    }
    if (!result.ok) return result;
    const auth = authGuard(opts.url, driver.currentUrl(), opts.authSelection);
    if (!auth.ok) return err(new Error(auth.message));
    const { endpoints, scenarios, exchangeCount, journey } = result.value;
    return ok({ endpoints, scenarios, exchangeCount, ...(journey ? { journey } : {}) });
  });
}

export type ObserveOutput = { sets: ObservationSet[]; observations: Observation[] };

export function commandObserve(opts: CommonOptions) {
  return withDriver(opts, async (driver) => {
    const nav = await driver.navigate(opts.url, { waitUntil: opts.waitUntil });
    if (!nav.ok) return nav;
    await driver.waitForIdle();
    const auth = authGuard(opts.url, driver.currentUrl(), opts.authSelection);
    if (!auth.ok) return err(new Error(auth.message));
    return ok(await observeAll(driver, opts.url));
  });
}

export type Budget = { requested: number; smoke: number; proof: number; seed: string };

export function normalizeBudgetArgs(
  values: { budget?: string; scenarios?: string; proofLimit?: string },
  supplied: { budget: boolean; scenarios: boolean },
): { count: number; proofLimit: number } {
  if (supplied.budget && supplied.scenarios)
    throw new Error("--scenarios and --budget cannot be combined");
  const count = Number(values.scenarios ?? values.budget ?? "3");
  const proofLimit = Number(values.proofLimit ?? "2");
  if (!Number.isInteger(count) || count < 1) throw new Error("--budget must be a positive integer");
  if (!Number.isInteger(proofLimit) || proofLimit < 0)
    throw new Error("--proof-limit must be a non-negative integer");
  return { count, proofLimit };
}

export type ChaosOutput = {
  /** One entry per scenario probed, in run order. */
  outcomes: ProbeOutcome[];
  scanned: { endpoints: number; scenarios: number };
  budget?: Budget;
  journey?: { id: string; receipts: JourneyReceipt[] };
  applicability:
    | { status: "applicable" }
    | {
        status: "not-applicable";
        reason: string;
        suggestions: string[];
      };
};

/**
 * Probe the app: scan its traffic, pick the highest-priority scenarios, then
 * run them concurrently. Each returns a before/after pair plus the
 * observations the fault introduced.
 */
export async function commandChaos(
  opts: CommonOptions,
  presetIds: string[],
  filter?: string,
  categories: ScenarioCategory[] = ["error"],
  count = 5,
  concurrency = 4,
  proofLimit = 2,
  fault?: "latency",
): Promise<Result<ChaosOutput>> {
  const scenarios: Scenario[] = [];
  let scanned = { endpoints: 0, scenarios: 0 };
  let journey: ChaosOutput["journey"];

  if (presetIds.length > 0) {
    // A preset is a fixed rule set, expressed here as one synthetic scenario
    // each so presets and derived faults share the same probe path.
    for (const id of presetIds) {
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset) return err(new Error(`Unknown preset "${id}"`));
      scenarios.push(presetAsScenario(preset, opts.url));
    }
  } else {
    const scan = await scanOnly(opts, filter);
    if (!scan.ok) return scan;
    scanned = {
      endpoints: scan.value.endpoints.length,
      scenarios: scan.value.scenarios.length,
    };
    scenarios.push(
      ...pickScenarios(
        scan.value.scenarios,
        fault === "latency" ? ["timing"] : categories,
        count,
        opts.url,
        fault,
      ),
    );
    journey = scan.value.journey;
    if (scenarios.length === 0) {
      return ok({
        outcomes: [],
        scanned,
        budget: {
          requested: count,
          smoke: 0,
          proof: 0,
          seed: opts.seed ?? "tremor-default-seed",
        },
        ...(journey ? { journey } : {}),
        applicability: {
          status: "not-applicable",
          reason: `No repeatable same-origin or browser-attested same-site GET XHR/fetch business API request eligible for ${fault === "latency" ? "--fault latency" : "the requested fault categories"} was observed during ${opts.journey ? "the declared journey" : "page load"}.`,
          suggestions:
            fault === "latency"
              ? [
                  "Ensure page load or the declared journey replays a GET XHR/fetch business API request.",
                  "Run scan without --fault to inspect the discovered endpoints.",
                ]
              : [
                  "Run scan to inspect the discovered endpoints.",
                  "Use --preset slow-network to exercise same-origin page-load degradation.",
                ],
        },
      });
    }
  }

  const outcomes = await probeScenarios(opts, scenarios, concurrency, "smoke");
  const authFailure = outcomes.find((outcome) => outcome.failureKind === "authentication");
  if (authFailure?.error) return err(authenticationError(authFailure));
  const candidates = selectProofCandidates(outcomes, proofLimit);
  if (candidates.length > 0) {
    const proofScenarios = candidates.map(({ index }) => {
      const scenario = scenarios[index];
      if (!scenario) throw new Error(`Missing scenario for proof candidate ${index}`);
      return scenario;
    });
    const proof = await probeScenarios(opts, proofScenarios, concurrency, "proof");
    const authFailure = proof.find((outcome) => outcome.failureKind === "authentication");
    if (authFailure?.error) return err(authenticationError(authFailure));
    mergeProofArtifacts(outcomes, candidates, proof, opts.runDir);
  }
  return ok({
    outcomes,
    scanned,
    budget: {
      requested: count,
      smoke: scenarios.length,
      proof: candidates.length,
      seed: opts.seed ?? "tremor-default-seed",
    },
    ...(journey ? { journey } : {}),
    applicability: { status: "applicable" },
  });
}

function authenticationError(outcome: ProbeOutcome): Error {
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

function presetAsScenario(preset: ChaosPreset, targetUrl: string): Scenario {
  const resourceTypes = [
    ...new Set(
      preset.rules.filter((rule) => rule.enabled).flatMap((rule) => rule.match.resourceTypes ?? []),
    ),
  ];
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    category: "error",
    priority: 0,
    endpoint: {
      method: "GET",
      pattern: `${new URL(targetUrl).origin}/**`,
      ...(resourceTypes.length > 0 ? { resourceTypes } : {}),
    },
    endpointType: "api",
    preset,
  };
}

async function scanOnly(opts: CommonOptions, filter?: string) {
  const created = await createPlaywrightDriver({
    url: opts.url,
    headless: opts.headless,
    artifactDir: opts.runDir,
    viewport: opts.viewport,
    timeoutMs: opts.timeoutMs,
    recordVideo: false,
    storageStatePath: opts.authState,
  });
  if (!created.ok) return created;
  const driver = created.value;
  try {
    if (opts.cpu) {
      const throttled = await driver.emulateCpuThrottle(cpuRateFor(opts.cpu));
      if (!throttled.ok) return throttled;
    }
    const replayCreated = opts.journey
      ? await createPlaywrightDriver({
          url: opts.url,
          headless: opts.headless,
          artifactDir: opts.runDir,
          viewport: opts.viewport,
          timeoutMs: opts.timeoutMs,
          recordVideo: false,
          storageStatePath: opts.authState,
        })
      : undefined;
    if (replayCreated && !replayCreated.ok) return replayCreated;
    const replayDriver = replayCreated?.ok ? replayCreated.value : undefined;
    if (replayDriver && opts.cpu) {
      const throttled = await replayDriver.emulateCpuThrottle(cpuRateFor(opts.cpu));
      if (!throttled.ok) {
        await replayDriver.close();
        return throttled;
      }
    }
    let result: Awaited<ReturnType<typeof scan>>;
    try {
      result = await scan(driver, {
        url: opts.url,
        filter,
        navigate: { waitUntil: opts.waitUntil },
        scenarios: { seed: opts.seed },
        replay: true,
        journey: opts.journey,
        replayDriver,
        authGuard: (activeDriver) =>
          authGuard(opts.url, activeDriver.currentUrl(), opts.authSelection),
      });
    } finally {
      await replayDriver?.close();
    }
    if (!result.ok) return result;
    const auth = authGuard(opts.url, driver.currentUrl(), opts.authSelection);
    if (!auth.ok) return err(new Error(auth.message));
    return ok(result.value);
  } finally {
    await driver.close();
  }
}

const LOW_VALUE_CHAOS_TARGET =
  /(?:analytics|telemetry|tracking|tracker|beacon|csrf|consent|cookie|captcha|challenge|metadata|health|\.status|schemas?|configs?|statsig|experiments?|feature[-_]?flags?|sentry|\/core\/l(?:\/|$)|\/ads?(?:\/|$))/i;
const BUSINESS_TARGET =
  /(?:\/api\/|graphql|feed|search|content|alerts?|recommend|prices?|products?|markets?|weather|forecast|geo|users?|accounts?|profile|notifications?|nav(?:igation)?)/i;

function scenarioUtility(scenario: Scenario, targetOrigin: string): number {
  let score = scenario.priority;
  try {
    if (new URL(scenario.endpoint.pattern).origin === targetOrigin) score += 4;
  } catch {
    return Number.NEGATIVE_INFINITY;
  }
  if (BUSINESS_TARGET.test(scenario.endpoint.pattern)) score += 6;
  return score;
}

/**
 * Select repeatable, browser-attested first-party API faults. Cross-origin
 * requests are admitted only when Chromium labelled them same-site; unknown
 * cross-origin relationships fail closed.
 */
export function pickScenarios(
  scenarios: Scenario[],
  categories: ScenarioCategory[],
  count: number,
  targetUrl: string,
  fault?: "latency",
): Scenario[] {
  const origin = new URL(targetUrl).origin;
  const eligible = scenarios.filter((s) => {
    if (
      !categories.includes(s.category) ||
      s.endpointType !== "api" ||
      s.endpoint.method !== "GET" ||
      !s.endpoint.resourceTypes?.some((t) => t === "xhr" || t === "fetch") ||
      s.endpoint.speculative === true ||
      s.endpoint.replayed === false ||
      LOW_VALUE_CHAOS_TARGET.test(s.endpoint.pattern)
    )
      return false;
    try {
      const sameOrigin = new URL(s.endpoint.pattern).origin === origin;
      return sameOrigin || s.endpoint.party === "same-site";
    } catch {
      return false;
    }
  });
  const faultEligible =
    fault === "latency"
      ? eligible.filter(
          (s) =>
            s.effect?.type === "latency" &&
            s.effect.distribution === "fixed" &&
            s.effect.ms === 1000,
        )
      : eligible;
  const safeForReplay = faultEligible.filter(
    (s) => s.category !== "corruption" || s.endpoint.method === "GET",
  );
  const pool = safeForReplay.length > 0 ? safeForReplay : faultEligible;
  // The one-command shorthand is deliberately safe: use unavailable (503),
  // never server-error (500), and spread deterministically across endpoints.
  const safeErrors = pool.filter((s) => s.category !== "error" || s.mock?.status === 503);
  const selectedPool = [...(safeErrors.length > 0 ? safeErrors : pool)].sort(
    (a, b) => scenarioUtility(b, origin) - scenarioUtility(a, origin) || a.id.localeCompare(b.id),
  );

  // Spread across endpoints: five 5xx variants of one endpoint teach less than
  // one fault on each of five endpoints.
  const seen = new Set<string>();
  const spread = selectedPool.filter((s) => {
    const k = `${s.endpoint.method} ${s.endpoint.pattern}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  // Spread first, then top up from the rest — never let one endpoint's five
  // status-code variants crowd out every other endpoint.
  const rest = selectedPool.filter((s) => !spread.includes(s));
  return [...spread, ...rest].slice(0, count);
}

async function observeAll(driver: Driver, url: string): Promise<ObserveOutput> {
  const sets: ObservationSet[] = [];
  for (const observer of OBSERVERS) {
    sets.push(await runObserver(observer, { driver, url }));
  }
  return { sets, observations: sets.flatMap((s) => s.observations) };
}
