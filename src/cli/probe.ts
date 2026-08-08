/**
 * Runs many fault scenarios concurrently, one isolated browser per scenario.
 *
 * Serial probing is useless for finding loopholes: a page load is ~7s, so
 * testing ten scenarios one at a time costs two minutes. Each scenario also
 * needs its own interceptor state, its own video, and its own before/after
 * screenshots, and sharing a page between them would entangle all three.
 * Separate drivers buy that isolation at the cost of a browser launch each,
 * which is roughly a second and overlaps with the others.
 */

import { join } from "node:path";
import { coarsePatternFor, scenarioInterceptor } from "../chaos/interceptor";
import { createPlaywrightDriver } from "../driver/playwright";
import { createLogger } from "../logging/logger";
import { captureContentState, diffContent } from "../observers/content";
import { runObserver } from "../observers/observer";
import { visualObserver } from "../observers/visual";
import type { Scenario } from "../types/chaos";
import type { Evidence, Observation } from "../types/observation";
import type { Result } from "../types/result";
import type { CommonOptions } from "./commands";

const log = createLogger("probe");

export type ProbeOutcome = {
  scenario: { id: string; name: string; category: string; endpoint: string };
  /** Observations present after the fault that were not there before it. */
  appeared: Observation[];
  disappeared: string[];
  unchangedCount: number;
  proof: {
    baselineShot: string | null;
    faultedShot: string | null;
    video: string | null;
  };
  /** Set when this scenario could not be evaluated; others still run. */
  error: string | null;
};

export async function probeScenarios(
  opts: CommonOptions,
  scenarios: Scenario[],
  concurrency: number,
): Promise<ProbeOutcome[]> {
  const results: ProbeOutcome[] = new Array(scenarios.length);
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor++;
      const scenario = scenarios[index];
      if (!scenario) return;
      results[index] = await probeOne(opts, scenario, index);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, scenarios.length) }, () => worker()),
  );
  return results;
}

function shotPath(result: Result<Evidence>): string | null {
  return result.ok && result.value.kind === "screenshot" ? result.value.path : null;
}

function describe(scenario: Scenario): ProbeOutcome["scenario"] {
  return {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    endpoint: `${scenario.endpoint.method} ${scenario.endpoint.pattern}`,
  };
}

async function probeOne(
  opts: CommonOptions,
  scenario: Scenario,
  index: number,
): Promise<ProbeOutcome> {
  const empty = (error: string | null, proof?: Partial<ProbeOutcome["proof"]>): ProbeOutcome => ({
    scenario: describe(scenario),
    appeared: [],
    disappeared: [],
    unchangedCount: 0,
    proof: { baselineShot: null, faultedShot: null, video: null, ...proof },
    error,
  });

  // Each scenario gets its own directory so screenshots and video never collide.
  const artifactDir = join(opts.runDir, `s${String(index + 1).padStart(2, "0")}`);

  const created = await createPlaywrightDriver({
    url: opts.url,
    headless: opts.headless,
    artifactDir,
    viewport: opts.viewport,
    timeoutMs: opts.timeoutMs,
    recordVideo: opts.video,
    storageStatePath: opts.authState,
  });
  if (!created.ok) return empty(created.error.message);

  const driver = created.value;
  try {
    const nav = await driver.navigate(opts.url, { waitUntil: opts.waitUntil });
    if (!nav.ok) return empty(nav.error.message);

    const baselineShot = await driver.screenshot({ label: "baseline" });
    const baselineContent = await captureContentState(driver);
    const baseline = (await runObserver(visualObserver, { driver, url: opts.url })).observations;

    const installed = await driver.intercept(scenarioInterceptor(scenario), {
      urlPattern: coarsePatternFor(scenario),
    });
    if (!installed.ok) return empty(installed.error.message);

    const reloaded = await driver.reload({ waitUntil: opts.waitUntil });
    // A fault that prevents the page loading at all is a result, not a failure —
    // capture what we can and let the caller judge it.
    const faultedShot = await driver.screenshot({ label: "faulted" });
    const after = reloaded.ok
      ? (await runObserver(visualObserver, { driver, url: opts.url })).observations
      : [];

    // The geometric observers are blind to "layout intact, data gone", which is
    // the common shape of a frontend failing a backend fault.
    const faultedContent = reloaded.ok ? await captureContentState(driver) : null;
    const contentDelta =
      baselineContent.ok && faultedContent?.ok
        ? diffContent(baselineContent.value, faultedContent.value)
        : [];

    const key = (o: Observation) => `${o.kind}|${o.target.selector ?? ""}`;
    const before = new Set(baseline.map(key));
    const now = new Set(after.map(key));
    const appeared = [...after.filter((o) => !before.has(key(o))), ...contentDelta];

    log.info(
      { scenario: scenario.name, appeared: appeared.length, navOk: reloaded.ok },
      "scenario probed",
    );

    return {
      scenario: describe(scenario),
      appeared,
      disappeared: baseline.filter((o) => !now.has(key(o))).map((o) => o.summary),
      unchangedCount: after.length - (appeared.length - contentDelta.length),
      proof: {
        baselineShot: shotPath(baselineShot),
        faultedShot: shotPath(faultedShot),
        // The path is known before close; the file is flushed by close().
        video: await driver.recordingPath(),
      },
      error: reloaded.ok ? null : `page did not load under fault: ${reloaded.error.message}`,
    };
  } finally {
    await driver.close();
  }
}
