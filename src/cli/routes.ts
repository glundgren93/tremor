import { createHash } from "node:crypto";
import type { Scenario } from "../types/chaos";

export const MAX_ROUTES = 10;

export type RouteRef = { id: string; path: string; url: string };
export type RouteAlias = {
  dedupKey: string;
  scenarioId: string;
  ownerRouteId: string;
  reason: "deduplicated-to-owner";
};

/** Parse the complete, explicit route list. The positional URL contributes only its origin. */
export function parseRoutes(value: string, positionalUrl: string): RouteRef[] {
  const origin = new URL(positionalUrl).origin;
  const raw = value.split(",");
  if (raw.length > MAX_ROUTES) throw new Error(`--routes accepts at most ${MAX_ROUTES} routes`);
  const seen = new Set<string>();
  return raw.map((entry, index) => {
    const path = entry.trim();
    if (!path) throw new Error("--routes contains an empty route");
    if (
      [...path].some(
        (character) =>
          /\s/u.test(character) ||
          (character.codePointAt(0) ?? 0) < 32 ||
          character.codePointAt(0) === 127,
      )
    )
      throw new Error(`Invalid route "${path}": whitespace and control characters are not allowed`);
    if (!path.startsWith("/") || path.startsWith("//"))
      throw new Error(`Invalid route "${path}": routes must have exactly one leading slash`);
    if (path.includes("?") || path.includes("#"))
      throw new Error(`Invalid route "${path}": query strings and fragments are not allowed`);
    // v1 route syntax is intentionally strict: reject ambiguous inputs before URL normalization.
    if (path.includes("\\") || path.includes("%"))
      throw new Error(`Invalid route "${path}": backslashes and percent escapes are not allowed`);
    if (path.split("/").some((segment) => segment === "." || segment === ".."))
      throw new Error(`Invalid route "${path}": dot segments are not allowed`);
    if (/^[a-z][a-z\d+.-]*:/iu.test(path.slice(1)))
      throw new Error(`Invalid route "${path}": schemes are not allowed`);
    const url = new URL(path, origin);
    if (url.origin !== origin)
      throw new Error(`Invalid route "${path}": cross-origin routes are not allowed`);
    // URL pathname is the canonical representation (dot segments and escapes resolved).
    const canonical = url.pathname;
    if (seen.has(canonical)) throw new Error(`Duplicate route "${canonical}"`);
    seen.add(canonical);
    return {
      id: `r${String(index + 1).padStart(2, "0")}`,
      path: canonical,
      url: `${origin}${canonical}`,
    };
  });
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, sorted(v)]),
    );
  return value;
}

/** Bounded semantic identity: response/effect behavior is deliberately complete. */
export function scenarioDedupKey(scenario: Scenario): string {
  const representation = {
    endpoint: {
      method: scenario.endpoint.method,
      pattern: scenario.endpoint.pattern,
      resourceTypes: [...new Set(scenario.endpoint.resourceTypes ?? [])].sort(),
      party: scenario.endpoint.party,
      speculative: scenario.endpoint.speculative,
      replayed: scenario.endpoint.replayed,
    },
    endpointType: scenario.endpointType,
    category: scenario.category,
    ...(scenario.mock ? { mock: scenario.mock } : {}),
    ...(scenario.effect ? { effect: scenario.effect } : {}),
    ...(scenario.preset ? { preset: scenario.preset } : {}),
  };
  return createHash("sha256")
    .update(JSON.stringify(sorted(representation)))
    .digest("hex");
}

export type OwnedRouteScenarios = {
  route: RouteRef;
  owned: Scenario[];
  aliases: RouteAlias[];
  eligible: number;
};

export function planRouteOwnership(
  inputs: { route: RouteRef; scenarios: Scenario[] }[],
): OwnedRouteScenarios[] {
  const owners = new Map<string, string>();
  return inputs.map(({ route, scenarios }) => {
    const owned: Scenario[] = [],
      aliases: RouteAlias[] = [];
    for (const scenario of scenarios) {
      const dedupKey = scenarioDedupKey(scenario);
      const ownerRouteId = owners.get(dedupKey);
      if (ownerRouteId)
        aliases.push({
          dedupKey,
          scenarioId: scenario.id,
          ownerRouteId,
          reason: "deduplicated-to-owner",
        });
      else {
        owners.set(dedupKey, route.id);
        owned.push(scenario);
      }
    }
    return { route, owned, aliases, eligible: scenarios.length };
  });
}

/** Fair global allocation, preserving both route and route-local order. */
export function roundRobin<T>(
  queues: readonly (readonly T[])[],
  limit: number,
): { routeIndex: number; value: T }[] {
  const cursors = queues.map(() => 0),
    result: { routeIndex: number; value: T }[] = [];
  while (result.length < limit) {
    let advanced = false;
    for (let routeIndex = 0; routeIndex < queues.length && result.length < limit; routeIndex++) {
      const value = queues[routeIndex]?.[cursors[routeIndex] ?? 0];
      if (value === undefined) continue;
      cursors[routeIndex] = (cursors[routeIndex] ?? 0) + 1;
      result.push({ routeIndex, value });
      advanced = true;
    }
    if (!advanced) break;
  }
  return result;
}
