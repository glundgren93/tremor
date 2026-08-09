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
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { authGuard } from "../auth/guard";
import { cpuRateFor } from "../capture/cpu-profiles";
import { coarsePatternFor, presetInterceptor, scenarioInterceptor } from "../chaos/interceptor";
import type { Driver } from "../driver/driver";
import { createPlaywrightDriver } from "../driver/playwright";
import { createLogger } from "../logging/logger";
import { captureContentState, diffContent } from "../observers/content";
import { runObserver } from "../observers/observer";
import { visualObserver } from "../observers/visual";
import type { FaultReceipt, Scenario } from "../types/chaos";
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
  receipts: FaultReceipt[];
  matchedCount: number;
  appliedCount: number;
  proof: {
    baselineShot: string | null;
    faultedShot: string | null;
    video: string | null;
  };
  /** Set when this scenario could not be evaluated; others still run. */
  error: string | null;
  /** Typed operational failure classification, when applicable. */
  failureKind?: "authentication";
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
  if (mode === "proof") deduplicateBaselineShots(results);
  return results;
}

/** Keep one canonical baseline image when isolated proof runs rendered the same page. */
export function deduplicateBaselineShots(outcomes: ProbeOutcome[]): void {
  const canonical = new Map<string, string>();
  for (const outcome of outcomes) {
    const path = outcome.proof.baselineShot;
    if (!path || !existsSync(path)) continue;
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
    if (sampleResult.ok) {
      const state = sampleResult.value;
      const signature = JSON.stringify({
        text: state.visibleTextLength,
        sample: state.textSample,
        elements: state.elementCount,
        headings: state.headings,
        errors: state.errorPhrases,
        spinners: state.spinnerCount,
        images: state.imageCount,
        links: state.linkCount,
        title: state.title,
      });
      const transitional = state.spinnerCount > 0 || TRANSITIONAL_TEXT.test(state.textSample);
      if (signature === previous && !transitional) {
        stableSince ??= now();
        if (now() - stableSince >= stableMs) return;
      } else {
        stableSince = null;
      }
      previous = signature;
    }
    await sleep(Math.min(sampleMs, Math.max(0, deadline - now())));
  }
}

function describe(scenario: Scenario): ProbeOutcome["scenario"] {
  return {
    id: scenario.id,
    name: scenario.name,
    category: scenario.category,
    endpoint: `${scenario.endpoint.method} ${scenario.endpoint.pattern}`,
  };
}

export async function probeOne(
  opts: CommonOptions,
  scenario: Scenario,
  index: number,
  mode: ProbeMode = "proof",
  driverOverride?: Driver,
  hooks: {
    settle?: (driver: Driver) => Promise<void>;
    observe?: (driver: Driver) => Promise<Observation[]>;
    content?: (driver: Driver) => ReturnType<typeof captureContentState>;
  } = {},
): Promise<ProbeOutcome> {
  const empty = (
    error: string | null,
    proof?: Partial<ProbeOutcome["proof"]>,
    failureKind?: ProbeOutcome["failureKind"],
  ): ProbeOutcome => ({
    scenario: describe(scenario),
    appeared: [],
    disappeared: [],
    unchangedCount: 0,
    receipts: [],
    matchedCount: 0,
    appliedCount: 0,
    proof: { baselineShot: null, faultedShot: null, video: null, ...proof },
    error,
    ...(failureKind ? { failureKind } : {}),
  });

  // Each scenario gets its own directory so screenshots and video never collide.
  const artifactDir = join(opts.runDir, `s${String(index + 1).padStart(2, "0")}`);

  const created = driverOverride
    ? ({ ok: true, value: driverOverride } as const)
    : await createPlaywrightDriver({
        url: opts.url,
        headless: opts.headless,
        artifactDir,
        viewport: opts.viewport,
        timeoutMs: opts.timeoutMs,
        recordVideo: mode === "proof" && opts.video,
        storageStatePath: opts.authState,
      });
  if (!created.ok) return empty(created.error.message);

  const driver = created.value;
  try {
    if (opts.cpu) {
      const throttled = await driver.emulateCpuThrottle(cpuRateFor(opts.cpu));
      if (!throttled.ok) return empty(throttled.error.message);
    }
    const nav = await driver.navigate(opts.url, { waitUntil: opts.waitUntil });
    if (!nav.ok) return empty(nav.error.message);
    await driver.waitForIdle();
    const auth = authGuard(opts.url, driver.currentUrl(), opts.authSelection);
    if (!auth.ok) return empty(auth.message, undefined, "authentication");
    if (mode === "proof")
      await (hooks.settle ? hooks.settle(driver) : settleVisibleContent(driver));

    const baselineContent = await (hooks.content
      ? hooks.content(driver)
      : captureContentState(driver));
    // Smoke probes deliberately avoid visual observers and all screenshot side effects.
    const baseline =
      mode === "proof"
        ? hooks.observe
          ? await hooks.observe(driver)
          : (await runObserver(visualObserver, { driver, url: opts.url, captureEvidence: false }))
              .observations
        : [];
    const baselineShot = mode === "proof" ? await driver.screenshot({ label: "baseline" }) : null;

    const interceptor = scenario.preset
      ? presetInterceptor(scenario.preset, {
          scenarioId: scenario.id,
          targetOrigin: new URL(opts.url).origin,
          seed: opts.seed,
        })
      : scenarioInterceptor(scenario);
    const installed = await driver.intercept(interceptor, {
      urlPattern: coarsePatternFor(scenario),
    });
    if (!installed.ok) return empty(installed.error.message);

    const reloaded = await driver.reload({ waitUntil: opts.waitUntil });
    // A fault that prevents the page loading at all is a result, not a failure —
    // capture what we can and let the caller judge it.
    await driver.waitForIdle();
    if (mode === "proof")
      await (hooks.settle ? hooks.settle(driver) : settleVisibleContent(driver));
    const receipts = driver.drainFaultReceipts();
    const after =
      mode === "proof" && reloaded.ok
        ? hooks.observe
          ? await hooks.observe(driver)
          : (await runObserver(visualObserver, { driver, url: opts.url, captureEvidence: false }))
              .observations
        : [];

    // The geometric observers are blind to "layout intact, data gone", which is
    // the common shape of a frontend failing a backend fault.
    const faultedContent = reloaded.ok
      ? await (hooks.content ? hooks.content(driver) : captureContentState(driver))
      : null;
    const faultedShot =
      mode === "proof" ? await driver.screenshot({ label: "faulted-final" }) : null;
    const contentDelta =
      baselineContent.ok && faultedContent?.ok
        ? diffContent(baselineContent.value, faultedContent.value)
        : [];

    const key = (o: Observation) => observationFingerprint(o);
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
      receipts,
      matchedCount: new Set(
        receipts
          .filter((r) => r.status === "matched" || r.status === "applied")
          .map((r) => `${r.method}\0${r.url}`),
      ).size,
      appliedCount: new Set(
        receipts.filter((r) => r.status === "applied").map((r) => `${r.method}\0${r.url}`),
      ).size,
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
