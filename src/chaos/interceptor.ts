/**
 * Turns scenarios and presets into `Interceptor`s the driver can install.
 *
 * This is the seam where v1's fault tooling meets the new engine: the matching
 * and effect logic are ported unchanged, but nothing here touches Playwright.
 */

import type { InterceptDecision, InterceptedRequest, Interceptor } from "../driver/driver";
import type { ChaosPreset, RequestMatcher, Scenario } from "../types/chaos";
import { seededRandom } from "../util/id";
import { decideEffects } from "./effects";
import { matchesRequest } from "./matcher";

/**
 * `matchesRequest` predates resource-type filtering, which presets rely on to
 * hit only xhr/fetch and leave the page shell alone.
 */
function matches(matcher: RequestMatcher, req: InterceptedRequest): boolean {
  if (matcher.resourceTypes && !matcher.resourceTypes.includes(req.resourceType)) return false;
  return matchesRequest(matcher, req.method, req.url, req.headers);
}

/** One scenario against one endpoint pattern. */
export function scenarioInterceptor(scenario: Scenario): Interceptor {
  const random = seededRandom(scenario.id);
  const matcher: RequestMatcher = {
    method: scenario.endpoint.method,
    urlPattern: scenario.endpoint.pattern,
    resourceTypes: scenario.endpoint.resourceTypes ?? ["xhr", "fetch"],
  };

  return async (req: InterceptedRequest): Promise<InterceptDecision> => {
    if (!matches(matcher, req)) return annotate({ action: "continue" }, scenario.id, false);

    if (scenario.mock) {
      const { status, headers, body, delay } = scenario.mock;
      if (delay > 0) await sleep(delay);
      return annotate({ action: "fulfill", status, headers, body }, scenario.id, true);
    }

    if (scenario.effect) {
      const decision = await decideEffects([scenario.effect], random);
      return annotate(decision, scenario.id, true);
    }
    return annotate({ action: "continue" }, scenario.id, true);
  };
}

/**
 * A preset is a list of rules. The first rule that matches and produces a
 * non-continue decision wins, matching v1's behaviour.
 *
 * `failCount` rules fail N times and then let traffic through — that is how
 * "recovers after retry" scenarios are expressed, so the counter is per
 * interceptor instance and resets only when a new interceptor is built.
 */
export function presetInterceptor(preset: ChaosPreset): Interceptor {
  const remaining = new Map<string, number>();
  for (const rule of preset.rules) {
    if (rule.failCount !== undefined) remaining.set(rule.name, rule.failCount);
  }

  return async (req: InterceptedRequest): Promise<InterceptDecision> => {
    for (const rule of preset.rules) {
      if (!rule.enabled) continue;
      if (!matches(rule.match, req)) continue;

      if (rule.failCount !== undefined) {
        const left = remaining.get(rule.name) ?? 0;
        if (left <= 0) continue;
        remaining.set(rule.name, left - 1);
      }

      const decision = await decideEffects(rule.effects);
      if (decision.action !== "continue") return decision;
    }
    return { action: "continue" };
  };
}

function annotate<T extends object>(decision: T, scenarioId: string, matched: boolean): T {
  for (const [key, value] of Object.entries({ matched, scenarioId, faultId: scenarioId })) {
    Object.defineProperty(decision, key, { value, enumerable: false });
  }
  return decision;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Coarse glob for `Driver.intercept`, derived from a scenario's endpoint.
 *
 * Deliberately generous — it only exists to spare the interceptor traffic it
 * could never match, and a pattern that is too narrow silently prevents the
 * fault from firing at all. Everything from the first wildcard onward is
 * replaced with `**`, and a trailing `**` absorbs query strings.
 */
export function coarsePatternFor(scenario: Scenario): string {
  const pattern = scenario.endpoint.pattern;
  const star = pattern.indexOf("*");
  const prefix = star >= 0 ? pattern.slice(0, star) : pattern;
  return `${prefix}**`;
}
