import { applyEffectPipeline, calculateLatency, corruptBody, shouldFire } from "../../core/chaos";
import { generateId } from "../../core/id";
import { matchesRequest } from "../../core/matcher";
import type { ChaosEffect, Scenario } from "../../core/types";
import { type ActiveFault, state, type WorkerContext } from "../../state";

export async function applyScenario(
  scenario: Scenario,
  failCount?: number,
  ctx?: WorkerContext,
): Promise<ActiveFault> {
  const page = ctx?.page ?? state.page;
  if (!page) throw new Error("No browser open");

  const pattern = scenario.endpoint.pattern;
  let failures = 0;

  const handler = async (route: import("playwright").Route) => {
    const request = route.request();
    const url = request.url();
    const method = request.method();

    const matcher = {
      urlPattern: pattern,
      method: scenario.endpoint.method,
    };

    if (!matchesRequest(matcher, method, url, request.headers())) {
      await route.fallback();
      return;
    }

    // If we've reached the failure limit, let requests through
    if (failCount !== undefined && failures >= failCount) {
      await route.fallback();
      return;
    }

    // Apply mock response
    if (scenario.mock) {
      const { mock } = scenario;
      if (mock.delay > 0) {
        await new Promise((r) => setTimeout(r, mock.delay));
      }
      await route.fulfill({
        status: scenario.mock.status,
        headers: scenario.mock.headers,
        body: scenario.mock.body,
      });
      failures++;
      return;
    }

    // Apply chaos effect via pipeline
    if (scenario.effect) {
      const result = await applyEffectPipeline(route, [scenario.effect]);
      if (result.fired) failures++;
      return;
    }

    await route.continue();
  };

  await page.route("**/*", handler);

  const fault: ActiveFault = {
    id: generateId(),
    endpoint: `${scenario.endpoint.method} ${scenario.endpoint.pattern}`,
    category: scenario.category,
    source: "scenario",
    endpointType: scenario.endpointType,
    handlers: [handler],
  };
  const activeFaults = ctx?.activeFaults ?? state.activeFaults;
  activeFaults.push(fault);
  return fault;
}

/** Apply a chaos effect to a route. Returns true if the effect actually fired (caused a failure). */
export async function applyChaosEffect(
  route: import("playwright").Route,
  effect: ChaosEffect,
): Promise<boolean> {
  switch (effect.type) {
    case "latency": {
      const delay = calculateLatency(effect);
      await new Promise((r) => setTimeout(r, delay));
      await route.continue();
      return true;
    }
    case "error": {
      if (shouldFire(effect.rate)) {
        await route.fulfill({
          status: effect.status,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ error: `Tremor injected ${effect.status}` }),
        });
        return true;
      }
      await route.continue();
      return false;
    }
    case "timeout": {
      if (shouldFire(effect.rate)) {
        await new Promise((r) => setTimeout(r, effect.afterMs));
        await route.abort("timedout");
        return true;
      }
      await route.continue();
      return false;
    }
    case "corrupt": {
      const response = await route.fetch();
      const body = await response.text();
      const corrupted = corruptBody(body, effect.mutations);
      await route.fulfill({
        status: response.status(),
        headers: response.headers(),
        body: corrupted,
      });
      return true;
    }
    case "throttle": {
      // Simplified: just add delay proportional to expected body size
      const delay = Math.round((50000 / effect.bytesPerSecond) * 1000);
      await new Promise((r) => setTimeout(r, delay));
      await route.continue();
      return true;
    }
    case "mock": {
      if (shouldFire(effect.rate)) {
        await route.fulfill({
          status: effect.status,
          headers: { "content-type": "application/json" },
          body: effect.body,
        });
        return true;
      }
      await route.continue();
      return false;
    }
  }
}

export function buildChaosEffect(effect: {
  type: string;
  ms?: number;
  status?: number;
  rate?: number;
}): ChaosEffect | null {
  switch (effect.type) {
    case "latency":
      return {
        type: "latency",
        ms: effect.ms ?? 3000,
        distribution: "fixed",
      };
    case "error":
      return {
        type: "error",
        status: effect.status ?? 500,
        rate: effect.rate ?? 1.0,
      };
    case "timeout":
      return {
        type: "timeout",
        rate: effect.rate ?? 1.0,
        afterMs: effect.ms ?? 30000,
      };
    default:
      return null;
  }
}
