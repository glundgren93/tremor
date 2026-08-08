/**
 * Capture pipeline: drive the browser, record traffic, derive fault scenarios.
 *
 * This is essence #2 — scenarios generated from the app's *actual* endpoints
 * rather than a fixed preset list — reconnected to the new `Driver`.
 */

import { type GenerateScenariosOptions, generateScenarios } from "../chaos/scenarios";
import type { Driver, NavigateOptions, RecordedExchange } from "../driver/driver";
import { createLogger } from "../logging/logger";
import type { CapturedRequest, Endpoint, HttpMethod, Scenario } from "../types/chaos";
import { err, ok, type Result } from "../types/result";
import { deduplicateEndpoints, filterEndpoints } from "./endpoints";

const log = createLogger("capture");

const KNOWN_METHODS = new Set<HttpMethod>([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

export type SettleOptions = {
  /** Stop waiting once no new exchange has arrived for this long. */
  quietMs?: number;
  /** Hard ceiling — polling endpoints never go quiet. */
  maxMs?: number;
  pollMs?: number;
};

export type ScanOptions = {
  settle?: SettleOptions;
  url: string;
  /** Substring filter applied to endpoint pathnames before scenarios are built. */
  filter?: string;
  navigate?: NavigateOptions;
  scenarios?: GenerateScenariosOptions;
};

export type ScanResult = {
  url: string;
  endpoints: Endpoint[];
  scenarios: Scenario[];
  exchangeCount: number;
};

/**
 * Collect exchanges until the page stops making requests.
 *
 * Returns everything drained, including what arrived before the first poll.
 */
async function settle(driver: Driver, options: SettleOptions = {}): Promise<RecordedExchange[]> {
  const quietMs = options.quietMs ?? 750;
  const maxMs = options.maxMs ?? 8_000;
  const pollMs = options.pollMs ?? 150;

  const collected: RecordedExchange[] = [];
  const deadline = Date.now() + maxMs;
  let lastActivity = Date.now();

  for (;;) {
    const batch = driver.drainExchanges();
    if (batch.length > 0) {
      collected.push(...batch);
      lastActivity = Date.now();
    }
    const now = Date.now();
    if (now - lastActivity >= quietMs || now >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  collected.push(...driver.drainExchanges());
  log.debug({ exchanges: collected.length }, "traffic settled");
  return collected;
}

/** Exchanges are driver-shaped; endpoint dedup expects v1's CapturedRequest. */
export function toCapturedRequests(exchanges: RecordedExchange[]): CapturedRequest[] {
  const out: CapturedRequest[] = [];
  for (const x of exchanges) {
    if (!x.response) continue;
    const method = x.method.toUpperCase() as HttpMethod;
    if (!KNOWN_METHODS.has(method)) continue;

    out.push({
      id: x.id,
      timestamp: x.timestamp,
      method,
      url: x.url,
      headers: x.requestHeaders,
      body: x.requestBody,
      resourceType: x.resourceType,
      response: {
        status: x.response.status,
        statusText: x.response.statusText,
        headers: x.response.headers,
        body: x.response.body,
        duration: x.response.durationMs,
      },
    });
  }
  return out;
}

/**
 * Load the page with recording on, then turn what it fetched into scenarios.
 * Applies no faults — this is the read-only reconnaissance step.
 */
export async function scan(driver: Driver, options: ScanOptions): Promise<Result<ScanResult>> {
  const started = await driver.startRecording();
  if (!started.ok) return started;

  const nav = await driver.navigate(options.url, options.navigate);
  if (!nav.ok) return err(nav.error);

  // Draining straight after navigate misses everything the app fetches once it
  // has booted, which on a client-rendered app is all of it. Wait for traffic
  // to go quiet instead of trusting the load event.
  const exchanges = await settle(driver, options.settle);
  await driver.stopRecording();
  const captured = toCapturedRequests(exchanges);

  const all = deduplicateEndpoints(captured, options.url);
  const endpoints = options.filter ? filterEndpoints(all, options.filter) : all;
  const scenarios = generateScenarios(endpoints, options.scenarios);

  log.info(
    {
      url: options.url,
      exchanges: exchanges.length,
      endpoints: endpoints.length,
      scenarios: scenarios.length,
    },
    "scan complete",
  );

  return ok({ url: options.url, endpoints, scenarios, exchangeCount: exchanges.length });
}
