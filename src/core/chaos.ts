import type { ChaosEffect } from "./types";
import type { Route } from "playwright";

/** Generate a normally-distributed random value using Box-Muller transform. */
function normalRandom(mean: number, stddev: number): number {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, mean + z * stddev);
}

/** Calculate delay in ms for a latency effect. */
export function calculateLatency(effect: Extract<ChaosEffect, { type: "latency" }>): number {
  switch (effect.distribution) {
    case "fixed":
      return effect.ms;
    case "uniform":
      return Math.random() * effect.ms;
    case "normal":
      return normalRandom(effect.ms, effect.ms * 0.3);
  }
}

/** Roll the dice — returns true if the effect should fire based on its rate. */
export function shouldFire(rate: number): boolean {
  return Math.random() < rate;
}

/** Apply corruption mutations to a JSON response body. */
export function corruptBody(
  body: string,
  mutations: Extract<ChaosEffect, { type: "corrupt" }>["mutations"],
): string {
  try {
    const parsed = JSON.parse(body);
    for (const mutation of mutations) {
      applyMutation(parsed, mutation.field, mutation);
    }
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}

function applyMutation(
  obj: Record<string, unknown>,
  field: string,
  mutation: { action: string; value?: unknown },
): void {
  // Wildcard: apply mutation to all top-level keys
  if (field === "*") {
    for (const key of Object.keys(obj)) {
      applySingleMutation(obj, key, mutation);
    }
    return;
  }

  const parts = field.split(".");
  let current: Record<string, unknown> = obj;

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part === undefined || typeof current[part] !== "object" || current[part] === null) return;
    current = current[part] as Record<string, unknown>;
  }

  const lastPart = parts[parts.length - 1];
  if (lastPart === undefined) return;
  applySingleMutation(current, lastPart, mutation);
}

function applySingleMutation(
  obj: Record<string, unknown>,
  key: string,
  mutation: { action: string; value?: unknown },
): void {
  switch (mutation.action) {
    case "remove":
      delete obj[key];
      break;
    case "nullify":
      obj[key] = null;
      break;
    case "empty":
      if (Array.isArray(obj[key])) obj[key] = [];
      else obj[key] = "";
      break;
    case "replace":
      obj[key] = mutation.value;
      break;
  }
}

/**
 * Compose multiple ChaosEffects within a single route handler.
 *
 * 1. Delay phase — accumulate all latency + throttle effects (additive), sleep once
 * 2. Terminal phase — try error, timeout, corrupt effects in array order; first whose shouldFire(rate) succeeds wins
 * 3. Fallthrough — if no terminal fires, route.continue() (request proceeds with delays applied)
 */
export async function applyEffectPipeline(
  route: Route,
  effects: ChaosEffect[],
): Promise<{ fired: boolean; totalDelay: number }> {
  // 1. Delay phase — accumulate all latency + throttle delays
  let totalDelay = 0;
  for (const effect of effects) {
    if (effect.type === "latency") {
      totalDelay += calculateLatency(effect);
    } else if (effect.type === "throttle") {
      totalDelay += Math.round((50000 / effect.bytesPerSecond) * 1000);
    }
  }
  if (totalDelay > 0) {
    await new Promise((r) => setTimeout(r, totalDelay));
  }

  // 2. Terminal phase — first terminal effect to fire wins
  for (const effect of effects) {
    switch (effect.type) {
      case "error": {
        if (shouldFire(effect.rate)) {
          await route.fulfill({
            status: effect.status,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: `Tremor injected ${effect.status}` }),
          });
          return { fired: true, totalDelay };
        }
        break;
      }
      case "timeout": {
        if (shouldFire(effect.rate)) {
          await new Promise((r) => setTimeout(r, effect.afterMs));
          await route.abort("timedout");
          return { fired: true, totalDelay };
        }
        break;
      }
      case "mock": {
        if (shouldFire(effect.rate)) {
          await route.fulfill({
            status: effect.status,
            headers: { "content-type": "application/json" },
            body: effect.body,
          });
          return { fired: true, totalDelay };
        }
        break;
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
        return { fired: true, totalDelay };
      }
    }
  }

  // 3. Fallthrough — no terminal fired, continue with delays applied
  await route.continue();
  return { fired: totalDelay > 0, totalDelay };
}
