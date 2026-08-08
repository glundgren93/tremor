import { scan } from "../capture/capture";
import { type CpuProfile, cpuRateFor } from "../capture/cpu-profiles";
import { PRESETS } from "../chaos/presets";
import type { Driver, WaitUntil } from "../driver/driver";
import { createPlaywrightDriver } from "../driver/playwright";
import { runObserver } from "../observers/observer";
import { visualObserver } from "../observers/visual";
import type { ChaosPreset, Endpoint, Scenario } from "../types/chaos";
import type { Observation, ObservationSet } from "../types/observation";
import { err, ok, type Result } from "../types/result";
import { type ProbeOutcome, probeScenarios } from "./probe";

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
  seed?: string;
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
};

export function commandScan(opts: CommonOptions, filter?: string) {
  return withDriver(opts, async (driver) => {
    const result = await scan(driver, {
      url: opts.url,
      filter,
      navigate: { waitUntil: opts.waitUntil },
      scenarios: { seed: opts.seed },
    });
    if (!result.ok) return result;
    const { endpoints, scenarios, exchangeCount } = result.value;
    return ok({ endpoints, scenarios, exchangeCount });
  });
}

export type ObserveOutput = { sets: ObservationSet[]; observations: Observation[] };

export function commandObserve(opts: CommonOptions) {
  return withDriver(opts, async (driver) => {
    const nav = await driver.navigate(opts.url, { waitUntil: opts.waitUntil });
    if (!nav.ok) return nav;
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
): Promise<Result<ChaosOutput>> {
  const scenarios: Scenario[] = [];
  let scanned = { endpoints: 0, scenarios: 0 };

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
    scenarios.push(...pickScenarios(scan.value.scenarios, categories, count, opts.url));
    if (scenarios.length === 0) {
      return err(
        new Error(
          `No api scenario in categor${categories.length > 1 ? "ies" : "y"} ${categories.join(", ")} could be generated for this URL`,
        ),
      );
    }
  }

  const outcomes = await probeScenarios(opts, scenarios, concurrency, "smoke");
  const candidates = selectProofCandidates(outcomes, proofLimit);
  if (candidates.length > 0) {
    const proofScenarios = candidates.map(({ index }) => {
      const scenario = scenarios[index];
      if (!scenario) throw new Error(`Missing scenario for proof candidate ${index}`);
      return scenario;
    });
    const proof = await probeScenarios(opts, proofScenarios, concurrency, "proof");
    mergeProofArtifacts(outcomes, candidates, proof);
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
  });
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
): void {
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    if (!candidate) continue;
    const smoke = outcomes[candidate.index];
    const rerun = proof[i];
    if (
      !smoke ||
      !rerun ||
      rerun.error ||
      rerun.appliedCount <= 0 ||
      rerun.receipts.some((r) => r.status === "error")
    )
      continue;
    smoke.proof = { ...smoke.proof, ...rerun.proof };
  }
}

function presetAsScenario(preset: ChaosPreset, targetUrl: string): Scenario {
  if (preset.rules.length !== 1)
    throw new Error(`Preset "${preset.id}" cannot be represented losslessly`);
  const rule = preset.rules[0];
  if (!rule || !rule.enabled || rule.effects.length !== 1)
    throw new Error(`Preset "${preset.id}" cannot be represented losslessly`);
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    category: "error",
    priority: 0,
    endpoint: {
      method: "GET",
      pattern: `${new URL(targetUrl).origin}/**`,
      resourceTypes: rule.match.resourceTypes,
    },
    endpointType: "api",
    effect: rule.effects[0],
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
    return await scan(driver, {
      url: opts.url,
      filter,
      navigate: { waitUntil: opts.waitUntil },
      scenarios: { seed: opts.seed },
    });
  } finally {
    await driver.close();
  }
}

/**
 * Scenarios arrive sorted by run order, so the first match is the highest
 * priority one. Corruption is the exception: applying it re-issues the real
 * request via `route.fetch()`, so a POST target would be submitted twice.
 * Prefer a GET when corrupting, and only fall back to POST if nothing else
 * exists.
 */
export function pickScenarios(
  scenarios: Scenario[],
  categories: ScenarioCategory[],
  count: number,
  targetUrl: string,
): Scenario[] {
  const origin = new URL(targetUrl).origin;
  const eligible = scenarios.filter(
    (s) =>
      categories.includes(s.category) &&
      s.endpointType === "api" &&
      s.endpoint.method === "GET" &&
      s.endpoint.resourceTypes?.some((t) => t === "xhr" || t === "fetch") &&
      (() => {
        try {
          return new URL(s.endpoint.pattern).origin === origin;
        } catch {
          return false;
        }
      })(),
  );
  const safeForReplay = eligible.filter(
    (s) => s.category !== "corruption" || s.endpoint.method === "GET",
  );
  const pool = safeForReplay.length > 0 ? safeForReplay : eligible;
  // The one-command shorthand is deliberately safe: use unavailable (503),
  // never server-error (500), and spread deterministically across endpoints.
  const safeErrors = pool.filter((s) => s.category !== "error" || s.mock?.status === 503);
  const selectedPool = safeErrors.length > 0 ? safeErrors : pool;

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
