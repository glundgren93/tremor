import type { InterceptDecision } from "../driver/driver";
import type { ChaosEffect } from "../types/chaos";
import { seededRandom } from "../util/id";

export const MAX_LATENCY_MS = 3000;
/** Finite upper bound for any wait handed to a transport driver. */
export const MAX_TRANSPORT_DELAY_MS = 30_000;

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
  let delay: number;
  switch (effect.distribution) {
    case "fixed":
      delay = effect.ms;
      break;
    case "uniform":
      delay = random() * effect.ms;
      break;
    case "normal":
      delay = normalRandom(effect.ms, effect.ms * 0.3, random);
      break;
  }
  if (!Number.isFinite(delay)) return 0;
  return Math.min(MAX_LATENCY_MS, Math.max(0, delay));
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
 * Decide what a set of chaos effects does to one request.
 *
 * Ported from v1's `applyEffectPipeline`, which called Playwright's `Route`
 * directly. It now returns an `InterceptDecision` so the same logic runs on any
 * `Driver` backend. Structure is unchanged:
 *
 *  1. Delay phase — latency is calculated here but transport waiting belongs
 *     exclusively to the driver.
 *  2. Terminal phase — the first effect whose rate roll succeeds wins.
 *  3. Fallthrough — no terminal fired, so the driver waits and proceeds.
 */
function delayInfo(effects: ChaosEffect[], random: () => number) {
  let latency = 0;
  let throttle = 0;
  for (const effect of effects) {
    if (effect.type === "latency")
      latency = Math.min(MAX_LATENCY_MS, latency + calculateLatency(effect, random));
    if (effect.type === "throttle") {
      const delay = Math.round((50_000 / effect.bytesPerSecond) * 1000);
      if (Number.isFinite(delay) && delay > 0)
        throttle = Math.min(MAX_TRANSPORT_DELAY_MS, throttle + delay);
    }
  }
  const total = Math.min(MAX_TRANSPORT_DELAY_MS, latency + throttle);
  const kind =
    latency > 0 && throttle > 0
      ? ("mixed" as const)
      : latency > 0
        ? ("latency" as const)
        : ("throttle" as const);
  return { total, kind, meta: total > 0 ? { preDelayMs: total, delayKind: kind } : {} };
}

function terminalEffect(
  effect: ChaosEffect,
  random: () => number,
  total: number,
  kind: "mixed" | "latency" | "throttle",
  meta: object,
): InterceptDecision | undefined {
  if (effect.type === "corrupt")
    return {
      action: "transform",
      transform: (real) => ({ ...real, body: corruptBody(real.body, effect.mutations) }),
      ...meta,
    };
  if (
    (effect.type !== "error" && effect.type !== "timeout" && effect.type !== "mock") ||
    !shouldFire(effect.rate, random)
  )
    return;
  if (effect.type === "error")
    return {
      action: "fulfill",
      status: effect.status,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: `Tremor injected ${effect.status}` }),
      ...meta,
    };
  if (effect.type === "mock")
    return {
      action: "fulfill",
      status: effect.status,
      headers: { "content-type": "application/json" },
      body: effect.body,
      ...meta,
    };
  const timeout = Number.isFinite(effect.afterMs) ? Math.max(0, effect.afterMs) : 0;
  const preDelayMs = Math.min(MAX_TRANSPORT_DELAY_MS, total + timeout);
  return {
    action: "abort",
    reason: "timedout",
    ...(preDelayMs > 0 ? { preDelayMs } : {}),
    ...(total > 0 ? { delayKind: kind } : {}),
  };
}

export async function decideEffects(
  effects: ChaosEffect[],
  random = seededRandom("tremor-default-seed"),
): Promise<InterceptDecision> {
  const info = delayInfo(effects, random);
  for (const effect of effects) {
    const decision = terminalEffect(effect, random, info.total, info.kind, info.meta);
    if (decision) return decision;
  }
  return info.total > 0
    ? { action: "delay", ms: info.total, delayKind: info.kind }
    : { action: "continue" };
}
