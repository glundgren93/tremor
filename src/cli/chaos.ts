import { navigationGuard } from "../auth/guard";
import { scan } from "../capture/capture";
import { cpuRateFor } from "../capture/cpu-profiles";
import { PRESETS } from "../chaos/presets";
import type { Driver } from "../driver/driver";
import { createPlaywrightDriver } from "../driver/playwright";
import type { ChaosPreset, Scenario } from "../types/chaos";
import { err, ok, type Result } from "../types/result";
import { probeScenarios } from "./probe";
import { authenticationError, mergeProofArtifacts, selectProofCandidates } from "./proof";
import { commandRouteChaos } from "./route-chaos";
import type { ChaosOutput, CommonOptions, RouteChaosOutput, ScenarioCategory } from "./types";

export type { ChaosOutput, RouteChaosOutput } from "./types";

export async function runScanWithDriver(opts: CommonOptions, driver: Driver, filter?: string) {
  const replay = opts.journey
    ? await createPlaywrightDriver({
        ...opts,
        artifactDir: opts.runDir,
        recordVideo: false,
        storageStatePath: opts.authState,
      })
    : undefined;
  if (replay && !replay.ok) return replay;
  const replayDriver = replay?.ok ? replay.value : undefined;
  try {
    if (replayDriver && opts.cpu) {
      const throttled = await replayDriver.emulateCpuThrottle(cpuRateFor(opts.cpu));
      if (!throttled.ok) return throttled;
    }
    const result = await scan(driver, {
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
    if (!result.ok) return result;
    const auth = navigationGuard(opts.url, driver.currentUrl(), opts.authSelection);
    if (!auth.ok) return err(new Error(auth.message));
    const { endpoints, scenarios, exchangeCount, journey } = result.value;
    return ok({ endpoints, scenarios, exchangeCount, ...(journey ? { journey } : {}) });
  } finally {
    await replayDriver?.close();
  }
}

type PreparedChaos = {
  scenarios: Scenario[];
  scanned: { endpoints: number; scenarios: number };
  journey?: ChaosOutput["journey"];
};
async function prepareChaosScenarios(
  opts: CommonOptions,
  presetIds: string[],
  filter: string | undefined,
  categories: ScenarioCategory[],
  count: number,
  fault?: "latency",
): Promise<Result<PreparedChaos>> {
  if (presetIds.length > 0) {
    const scenarios: Scenario[] = [];
    for (const id of presetIds) {
      const preset = PRESETS.find((p) => p.id === id);
      if (!preset) return err(new Error(`Unknown preset "${id}"`));
      scenarios.push(presetAsScenario(preset, opts.url));
    }
    return ok({ scenarios, scanned: { endpoints: 0, scenarios: 0 } });
  }
  const result = await scanOnly(opts, filter);
  if (!result.ok) return result;
  const scenarios = pickScenarios(
    result.value.scenarios,
    fault === "latency" ? ["timing"] : categories,
    count,
    opts.url,
    fault,
  );
  return ok({
    scenarios,
    scanned: { endpoints: result.value.endpoints.length, scenarios: result.value.scenarios.length },
    journey: result.value.journey,
  });
}

function emptyChaos(
  opts: CommonOptions,
  scanned: { endpoints: number; scenarios: number },
  journey: ChaosOutput["journey"],
  count: number,
  fault?: "latency",
): Result<ChaosOutput> {
  return ok({
    outcomes: [],
    scanned,
    budget: { requested: count, smoke: 0, proof: 0, seed: opts.seed ?? "tremor-default-seed" },
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
  const prepared = await prepareChaosScenarios(opts, presetIds, filter, categories, count, fault);
  if (!prepared.ok) return prepared;
  const { scenarios, scanned, journey } = prepared.value;

  if (scenarios.length === 0) return emptyChaos(opts, scanned, journey, count, fault);

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

export async function scanOnly(opts: CommonOptions, filter?: string) {
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
