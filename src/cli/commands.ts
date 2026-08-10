import { unlinkSync } from "node:fs";
import { type AuthSelection, navigationGuard } from "../auth/guard";
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
import {
  deduplicateBaselineShots,
  isOwnedMedia,
  type ProbeOutcome,
  probeOne,
  probeScenarios,
} from "./probe";
import { planRouteOwnership, type RouteAlias, type RouteRef, roundRobin } from "./routes";

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
  routes?: RouteRef[];
  route?: RouteRef;
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
export type RouteScanOutput = {
  mode: "routes";
  routes: {
    route: RouteRef;
    scan: ScanOutput & { applicability: "applicable" | "not-applicable" };
    aliases: RouteAlias[];
    ownedScenarioIds: string[];
  }[];
  scanned: { endpoints: number; scenarios: number; exchanges: number };
};

export async function commandScan(
  opts: CommonOptions,
  filter?: string,
): Promise<Result<(ScanOutput | RouteScanOutput) & { videoPath: string | null }>> {
  if (opts.routes) {
    const routes: RouteScanOutput["routes"] = [];
    for (const route of opts.routes) {
      const result = await scanOnly(
        {
          ...opts,
          routes: undefined,
          url: route.url,
          runDir: `${opts.runDir}/routes/${route.id}/scan`,
          video: false,
        },
        filter,
      );
      if (!result.ok) return result;
      const value = result.value as ScanOutput;
      routes.push({
        route,
        scan: { ...value, applicability: "not-applicable" },
        aliases: [],
        ownedScenarioIds: [],
      });
    }
    const ownership = planRouteOwnership(
      routes.map(({ route, scan }) => ({
        route,
        scenarios: pickScenarios(scan.scenarios, ["error"], Number.MAX_SAFE_INTEGER, route.url),
      })),
    );
    ownership.forEach((entry, index) => {
      const target = routes[index];
      if (!target) return;
      target.scan.applicability = entry.eligible > 0 ? "applicable" : "not-applicable";
      target.aliases = entry.aliases;
      target.ownedScenarioIds = entry.owned.map((scenario) => scenario.id);
    });
    return ok({
      mode: "routes",
      routes,
      scanned: {
        endpoints: routes.reduce((n, r) => n + r.scan.endpoints.length, 0),
        scenarios: routes.reduce((n, r) => n + r.scan.scenarios.length, 0),
        exchanges: routes.reduce((n, r) => n + r.scan.exchangeCount, 0),
      },
      videoPath: null,
    });
  }
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
          navigationGuard(opts.url, activeDriver.currentUrl(), opts.authSelection),
      });
    } finally {
      await replayDriver?.close();
    }
    if (!result.ok) return result;
    const auth = navigationGuard(opts.url, driver.currentUrl(), opts.authSelection);
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
    const auth = navigationGuard(opts.url, driver.currentUrl(), opts.authSelection);
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

export type RouteBudget = {
  eligible: number;
  owned: number;
  deduplicated: number;
  smoke: number;
  proof: number;
};
export type RouteChaosOutput = {
  mode: "routes";
  scanned: { endpoints: number; scenarios: number };
  applicability: ChaosOutput["applicability"];
  budget: Budget & { proofLimit: number };
  routes: {
    route: RouteRef;
    scanned: { endpoints: number; scenarios: number; exchanges: number };
    applicability: ChaosOutput["applicability"];
    budget: RouteBudget;
    aliases: RouteAlias[];
    outcomes: ProbeOutcome[];
  }[];
};

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
): Promise<Result<ChaosOutput | RouteChaosOutput>> {
  if (opts.routes)
    return commandRouteChaos(opts, filter, categories, count, concurrency, proofLimit, fault);
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

export async function commandRouteChaos(
  opts: CommonOptions,
  filter: string | undefined,
  categories: ScenarioCategory[],
  count: number,
  concurrency: number,
  proofLimit: number,
  fault?: "latency",
): Promise<Result<RouteChaosOutput>> {
  const discovered: { route: RouteRef; scan: ScanOutput; eligible: Scenario[] }[] = [];
  for (const route of opts.routes ?? []) {
    const routeOpts = {
      ...opts,
      routes: undefined,
      route,
      url: route.url,
      runDir: `${opts.runDir}/routes/${route.id}/scan`,
      video: false,
    };
    const scanned = await scanOnly(routeOpts, filter);
    if (!scanned.ok) return scanned;
    const eligible = pickScenarios(
      scanned.value.scenarios,
      fault === "latency" ? ["timing"] : categories,
      Number.MAX_SAFE_INTEGER,
      route.url,
      fault,
    );
    discovered.push({ route, scan: scanned.value, eligible });
  }
  const ownership = planRouteOwnership(
    discovered.map(({ route, eligible }) => ({ route, scenarios: eligible })),
  );
  const smokePlans = roundRobin(
    ownership.map((entry) => entry.owned),
    count,
  ).map((plan, ordinal) => ({ ...plan, ordinal }));
  const outcomesByRoute: ProbeOutcome[][] = ownership.map(() => []);
  const runPlans = async (plans: typeof smokePlans, mode: "smoke" | "proof") => {
    const results = new Array<ProbeOutcome>(plans.length);
    let cursor = 0;
    await Promise.all(
      Array.from({ length: Math.min(concurrency, plans.length) }, async () => {
        for (;;) {
          const ordinal = cursor++;
          const plan = plans[ordinal];
          if (!plan) return;
          const route = ownership[plan.routeIndex]?.route;
          if (!route) return;
          results[ordinal] = await probeOne(
            {
              ...opts,
              routes: undefined,
              route,
              url: route.url,
              runDir: `${opts.runDir}/routes/${route.id}/probes`,
            },
            plan.value,
            plan.ordinal,
            mode,
          );
        }
      }),
    );
    return results;
  };
  const smoke = await runPlans(smokePlans, "smoke");
  const operational = smoke.find(
    (outcome) => outcome.failureKind === "authentication" || outcome.failureKind === "origin",
  );
  if (operational?.error) return err(new Error(operational.error));
  smoke.forEach((outcome, index) => {
    const plan = smokePlans[index];
    if (outcome && plan) outcomesByRoute[plan.routeIndex]?.push(outcome);
  });

  const qualifying = outcomesByRoute.map((outcomes) =>
    selectProofCandidates(outcomes, Number.MAX_SAFE_INTEGER),
  );
  const proofSelections = roundRobin(qualifying, proofLimit);
  const proofPlans = proofSelections.map(({ routeIndex, value }) => {
    const routePlans = smokePlans.filter((plan) => plan.routeIndex === routeIndex);
    const smokePlan = routePlans[value.index];
    if (!smokePlan)
      throw new Error(`Missing smoke plan for route ${routeIndex} proof candidate ${value.index}`);
    return { routeIndex, value: smokePlan.value, ordinal: smokePlan.ordinal };
  });
  const proof = await runPlans(proofPlans, "proof");
  // Baselines are comparable only within a route probe root. Never deduplicate across routes.
  for (let routeIndex = 0; routeIndex < ownership.length; routeIndex++) {
    const route = ownership[routeIndex]?.route;
    if (!route) continue;
    deduplicateBaselineShots(
      proof.filter((_, index) => proofPlans[index]?.routeIndex === routeIndex),
      `${opts.runDir}/routes/${route.id}/probes`,
    );
  }
  const proofOperational = proof.find(
    (outcome) => outcome.failureKind === "authentication" || outcome.failureKind === "origin",
  );
  if (proofOperational?.error) return err(new Error(proofOperational.error));
  // Merge once per route so all accepted canonical baselines are protected before
  // any rejected sibling artifacts are removed.
  for (let routeIndex = 0; routeIndex < ownership.length; routeIndex++) {
    const route = ownership[routeIndex]?.route;
    if (!route) continue;
    const selected = proofSelections
      .map((selection, proofIndex) => ({ selection, proofIndex }))
      .filter(({ selection }) => selection.routeIndex === routeIndex);
    mergeProofArtifacts(
      outcomesByRoute[routeIndex] ?? [],
      selected.map(({ selection }) => ({ index: selection.value.index })),
      selected.map(({ proofIndex }) => proof[proofIndex]).filter((value) => value !== undefined),
      `${opts.runDir}/routes/${route.id}/probes`,
    );
  }

  const routes = ownership.map((entry, routeIndex) => {
    const found = discovered[routeIndex];
    const outcomes = outcomesByRoute[routeIndex] ?? [];
    const proofCount = proofSelections.filter(
      (selection) => selection.routeIndex === routeIndex,
    ).length;
    const applicable = entry.eligible > 0;
    return {
      route: entry.route,
      scanned: {
        endpoints: found?.scan.endpoints.length ?? 0,
        scenarios: found?.scan.scenarios.length ?? 0,
        exchanges: found?.scan.exchangeCount ?? 0,
      },
      applicability: applicable
        ? {
            status: "applicable" as const,
            ...(entry.owned.length === 0
              ? {
                  reason:
                    "Eligible candidates were deduplicated to a representative owner route; this route was not tested.",
                }
              : {}),
          }
        : {
            status: "not-applicable" as const,
            reason: "No eligible repeatable business API scenario was observed.",
            suggestions: ["Run scan to inspect this route's endpoints."],
          },
      budget: {
        eligible: entry.eligible,
        owned: entry.owned.length,
        deduplicated: entry.aliases.length,
        smoke: outcomes.length,
        proof: proofCount,
      },
      aliases: entry.aliases,
      outcomes,
    };
  });
  const anyApplicable = routes.some((route) => route.budget.eligible > 0);
  return ok({
    mode: "routes",
    scanned: {
      endpoints: routes.reduce((sum, route) => sum + route.scanned.endpoints, 0),
      scenarios: routes.reduce((sum, route) => sum + route.scanned.scenarios, 0),
    },
    applicability: anyApplicable
      ? { status: "applicable" }
      : {
          status: "not-applicable",
          reason: "No route contained an eligible scenario.",
          suggestions: ["Run scan to inspect route endpoints."],
        },
    budget: {
      requested: count,
      smoke: smoke.length,
      proofLimit,
      proof: proofSelections.length,
      seed: opts.seed ?? "tremor-default-seed",
    },
    routes,
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
    const replayCreated = await createPlaywrightDriver({
      url: opts.url,
      headless: opts.headless,
      artifactDir: opts.runDir,
      viewport: opts.viewport,
      timeoutMs: opts.timeoutMs,
      recordVideo: false,
      storageStatePath: opts.authState,
    });
    if (!replayCreated.ok) return replayCreated;
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
          navigationGuard(opts.url, activeDriver.currentUrl(), opts.authSelection),
      });
    } finally {
      await replayDriver?.close();
    }
    if (!result.ok) return result;
    const auth = navigationGuard(opts.url, driver.currentUrl(), opts.authSelection);
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
