import { navigationGuard } from "../auth/guard";
import { cpuRateFor } from "../capture/cpu-profiles";
import type { Driver } from "../driver/driver";
import { createPlaywrightDriver } from "../driver/playwright";
import { runObserver } from "../observers/observer";
import { visualObserver } from "../observers/visual";
import type { ObservationSet } from "../types/observation";
import { err, ok, type Result } from "../types/result";
import { pickScenarios, runScanWithDriver, scanOnly } from "./chaos";
import { planRouteOwnership } from "./routes";
import type { CommonOptions, ObserveOutput, RouteScanOutput, ScanOutput } from "./types";

export { commandChaos, pickScenarios } from "./chaos";
export {
  mergeProofArtifacts,
  removeProvisionalProofArtifacts,
  selectProofCandidates,
} from "./proof";
export { commandRouteChaos } from "./route-chaos";
export type {
  ChaosOutput,
  CommonOptions,
  ObserveOutput,
  RouteChaosOutput,
  RouteScanOutput,
  ScanOutput,
  ScenarioCategory,
} from "./types";

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
  return withDriver(opts, (driver) => runScanWithDriver(opts, driver, filter));
}

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

async function observeAll(driver: Driver, url: string): Promise<ObserveOutput> {
  const sets: ObservationSet[] = [];
  for (const observer of OBSERVERS) {
    sets.push(await runObserver(observer, { driver, url }));
  }
  return { sets, observations: sets.flatMap((s) => s.observations) };
}
