import type { Endpoint, EndpointType, HttpMethod, Scenario } from "../types/chaos";
import { stableId } from "../util/id";
import { walkJson } from "./json-walk";

const ERROR_SCENARIOS: { status: number; name: string; description: string }[] = [
  { status: 500, name: "Server Error", description: "Returns 500 Internal Server Error" },
  { status: 503, name: "Service Unavailable", description: "Returns 503 Service Unavailable" },
  { status: 404, name: "Not Found", description: "Returns 404 Not Found" },
  { status: 401, name: "Unauthorized", description: "Returns 401 Unauthorized" },
  { status: 429, name: "Rate Limited", description: "Returns 429 Too Many Requests" },
];

const TIMING_SCENARIOS: {
  ms: number;
  name: string;
  description: string;
  distribution: "fixed" | "uniform" | "normal";
}[] = [
  { ms: 1000, name: "Latency (1s)", description: "1 second delay", distribution: "fixed" },
  { ms: 3000, name: "Bounded latency (3s)", description: "3 second delay", distribution: "fixed" },
];

const PRIORITY_METHODS: Record<string, number> = {
  POST: 3,
  PUT: 2,
  PATCH: 2,
  DELETE: 2,
  GET: 1,
  HEAD: 0,
  OPTIONS: 0,
};

/** Large enough to outrank any method/auth combination a third party can score. */
const FIRST_PARTY_BOOST = 10;

const AUTH_PATTERNS = [/auth/i, /login/i, /token/i, /session/i, /oauth/i];

function endpointPriority(endpoint: Endpoint): number {
  let priority = PRIORITY_METHODS[endpoint.method] ?? 1;
  if (AUTH_PATTERNS.some((p) => p.test(endpoint.pattern))) {
    priority += 2;
  }
  // Third-party ad/analytics traffic outnumbers app traffic on real sites, and
  // POSTing to an ad exchange outranks GETting the app's own data on method
  // alone. Testing what happens when someone else's beacon fails is not what
  // the user asked for, so first-party endpoints sort above everything.
  if (endpoint.firstParty !== false) {
    priority += FIRST_PARTY_BOOST;
  }
  return priority;
}

function endpointLabel(method: HttpMethod, pattern: string): string {
  try {
    const url = new URL(pattern);
    return `${method} ${url.pathname}`;
  } catch {
    return `${method} ${pattern}`;
  }
}

function journeyMetadata(
  endpoint: Endpoint,
): Pick<Scenario, "journeyId" | "checkpointId" | "observedStepId"> {
  return {
    ...(endpoint.journeyId ? { journeyId: endpoint.journeyId } : {}),
    ...(endpoint.checkpointId ? { checkpointId: endpoint.checkpointId } : {}),
    ...(endpoint.observedStepId ? { observedStepId: endpoint.observedStepId } : {}),
  };
}

function scenarioEndpoint(endpoint: Endpoint): Scenario["endpoint"] {
  return {
    method: endpoint.method,
    pattern: endpoint.pattern,
    resourceTypes: endpoint.resourceTypes,
    party: endpoint.party,
    speculative: endpoint.speculative,
    replayed: endpoint.replayed,
  };
}

export interface GenerateScenariosOptions {
  categories?: ("error" | "timing" | "empty" | "corruption")[];
  seed?: string;
}

/**
 * Generate fault scenarios from deduplicated endpoints.
 * Per endpoint generates: errors, timing issues, empty responses, field corruptions.
 */
export function generateScenarios(
  endpoints: Endpoint[],
  options?: GenerateScenariosOptions,
): Scenario[] {
  const categories = options?.categories ?? ["error", "timing", "empty", "corruption"];
  const seed = options?.seed ?? "tremor-default-seed";
  const scenarios: Scenario[] = [];
  const makeId = (kind: string, endpoint: Endpoint, index: number) =>
    stableId(
      endpoint.journeyId
        ? `${kind}:${endpoint.journeyId}:${endpoint.checkpointId ?? ""}:${endpoint.observedStepId ?? ""}:${endpoint.method}:${endpoint.pattern}:${endpoint.resourceTypes?.join(",") ?? ""}:${index}`
        : `${kind}:${endpoint.method}:${endpoint.pattern}:${endpoint.resourceTypes?.join(",") ?? ""}:${index}`,
      seed,
    );

  for (const endpoint of endpoints) {
    if (endpoint.method !== "GET") continue;
    const basePriority = endpointPriority(endpoint);
    const label = endpointLabel(endpoint.method, endpoint.pattern);
    const epType: EndpointType = endpoint.endpointType ?? "api";

    // Document endpoints only get timing scenarios (slow + timeout).
    // Error/empty/corruption on documents test infrastructure, not the app.
    const effectiveCategories =
      epType === "document" ? categories.filter((c) => c === "timing") : categories;

    if (effectiveCategories.includes("error")) {
      for (const err of ERROR_SCENARIOS) {
        scenarios.push({
          id: makeId("error", endpoint, err.status),
          name: `${label} → ${err.name}`,
          description: `${err.description} for ${label}`,
          category: "error",
          priority: basePriority + 1,
          endpoint: scenarioEndpoint(endpoint),
          endpointType: epType,
          ...journeyMetadata(endpoint),
          mock: {
            status: err.status,
            statusText: err.name,
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ error: err.name }),
            delay: 0,
          },
        });
      }
    }

    if (effectiveCategories.includes("timing")) {
      for (const timing of TIMING_SCENARIOS) {
        scenarios.push({
          id: makeId("timing", endpoint, timing.ms),
          name: `${label} → ${timing.name}`,
          description: `${timing.description} for ${label}`,
          category: "timing",
          priority: basePriority,
          endpoint: scenarioEndpoint(endpoint),
          endpointType: epType,
          ...journeyMetadata(endpoint),
          effect: { type: "latency", ms: timing.ms, distribution: timing.distribution },
        });
      }

      scenarios.push({
        id: makeId("timeout", endpoint, 2),
        name: `${label} → Timeout`,
        description: `Request times out for ${label}`,
        category: "timing",
        priority: basePriority + 1,
        endpoint: scenarioEndpoint(endpoint),
        endpointType: epType,
        ...journeyMetadata(endpoint),
        effect: { type: "timeout", rate: 1.0, afterMs: 30000 },
      });
    }

    if (effectiveCategories.includes("empty")) {
      scenarios.push({
        id: makeId("empty", endpoint, 3),
        name: `${label} → Empty Response`,
        description: `Returns empty body for ${label}`,
        category: "empty",
        priority: basePriority,
        endpoint: scenarioEndpoint(endpoint),
        endpointType: epType,
        ...journeyMetadata(endpoint),
        mock: {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: endpoint.sampleResponse?.body?.startsWith("[") ? "[]" : "{}",
          delay: 0,
        },
      });
    }

    if (effectiveCategories.includes("corruption") && endpoint.sampleResponse?.body) {
      const fields = walkJson(endpoint.sampleResponse.body);
      const mutatable = fields.filter((f) => f.type !== "object");

      if (mutatable.length > 0) {
        const mutations = mutatable.slice(0, 5).map((f) => ({
          field: f.path,
          action: "nullify" as const,
        }));

        scenarios.push({
          id: makeId("corruption", endpoint, fields.length),
          name: `${label} → Corrupted Fields`,
          description: `Nullifies key fields in ${label} response`,
          category: "corruption",
          priority: basePriority,
          endpoint: scenarioEndpoint(endpoint),
          endpointType: epType,
          ...journeyMetadata(endpoint),
          effect: { type: "corrupt", mutations },
        });
      }
    }
  }

  return scenarios.sort((a, b) => b.priority - a.priority);
}
