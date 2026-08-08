import type { InterceptDecision } from "../driver/driver";
import type { ChaosEffect } from "../types/chaos";
import { seededRandom } from "../util/id";

/** Generate a normally-distributed random value using Box-Muller transform. */
function normalRandom(mean: number, stddev: number, random: () => number): number {
  const u1 = Math.max(Number.EPSILON, random());
  const u2 = random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  return Math.max(0, mean + z * stddev);
}

/** Calculate delay in ms for a latency effect. */
export function calculateLatency(
  effect: Extract<ChaosEffect, { type: "latency" }>,
  random = Math.random,
): number {
  switch (effect.distribution) {
    case "fixed":
      return effect.ms;
    case "uniform":
      return random() * effect.ms;
    case "normal":
      return normalRandom(effect.ms, effect.ms * 0.3, random);
  }
}

/** Roll the dice — returns true if the effect should fire based on its rate. */
export function shouldFire(rate: number, random = Math.random): boolean {
  return random() < rate;
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

/**
 * Decide what a set of chaos effects does to one request.
 *
 * Ported from v1's `applyEffectPipeline`, which called Playwright's `Route`
 * directly. It now returns an `InterceptDecision` so the same logic runs on any
 * `Driver` backend. Structure is unchanged:
 *
 *  1. Delay phase — all latency and throttle effects accumulate and are awaited
 *     once, so a slow-and-failing endpoint is slow *and* fails.
 *  2. Terminal phase — the first effect whose rate roll succeeds wins.
 *  3. Fallthrough — no terminal fired, so the request proceeds (with the delay
 *     already applied).
 */
export async function decideEffects(
  effects: ChaosEffect[],
  random = seededRandom("tremor-default-seed"),
): Promise<InterceptDecision> {
  let totalDelay = 0;
  for (const effect of effects) {
    if (effect.type === "latency") {
      totalDelay += calculateLatency(effect, random);
    } else if (effect.type === "throttle") {
      totalDelay += Math.round((50000 / effect.bytesPerSecond) * 1000);
    }
  }
  if (totalDelay > 0) {
    await new Promise((r) => setTimeout(r, totalDelay));
  }

  for (const effect of effects) {
    switch (effect.type) {
      case "error":
        if (shouldFire(effect.rate, random)) {
          return {
            action: "fulfill",
            status: effect.status,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: `Tremor injected ${effect.status}` }),
          };
        }
        break;
      case "timeout":
        if (shouldFire(effect.rate, random)) {
          await new Promise((r) => setTimeout(r, effect.afterMs));
          return { action: "abort", reason: "timedout" };
        }
        break;
      case "mock":
        if (shouldFire(effect.rate, random)) {
          return {
            action: "fulfill",
            status: effect.status,
            headers: { "content-type": "application/json" },
            body: effect.body,
          };
        }
        break;
      case "corrupt":
        // Mutates the app's real payload — a synthetic body would not exercise
        // the same parsing path.
        return {
          action: "transform",
          transform: (real) => ({ ...real, body: corruptBody(real.body, effect.mutations) }),
        };
    }
  }

  return { action: "continue" };
}
