import { generateId } from "./id";
import { walkJson } from "./json-walk";
import type { Endpoint, EndpointType, HttpMethod, Scenario } from "./types";

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
  { ms: 3000, name: "Slow (3s)", description: "3 second delay", distribution: "fixed" },
  { ms: 10000, name: "Very Slow (10s)", description: "10 second delay", distribution: "fixed" },
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

const AUTH_PATTERNS = [/auth/i, /login/i, /token/i, /session/i, /oauth/i];

function endpointPriority(endpoint: Endpoint): number {
  let priority = PRIORITY_METHODS[endpoint.method] ?? 1;
  if (AUTH_PATTERNS.some((p) => p.test(endpoint.pattern))) {
    priority += 2;
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

export interface GenerateScenariosOptions {
  categories?: ("error" | "timing" | "empty" | "corruption")[];
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
  const scenarios: Scenario[] = [];

  for (const endpoint of endpoints) {
    const basePriority = endpointPriority(endpoint);
    const label = endpointLabel(endpoint.method, endpoint.pattern);
    const epType: EndpointType = endpoint.endpointType ?? "api";

    // Document endpoints only get timing scenarios (slow + timeout).
    // Error/empty/corruption on documents test infrastructure, not the app.
    const effectiveCategories =
      epType === "document"
        ? categories.filter((c) => c === "timing")
        : categories;

    if (effectiveCategories.includes("error")) {
      for (const err of ERROR_SCENARIOS) {
        scenarios.push({
          id: generateId(),
          name: `${label} → ${err.name}`,
          description: `${err.description} for ${label}`,
          category: "error",
          priority: basePriority + 1,
          endpoint: { method: endpoint.method, pattern: endpoint.pattern },
          endpointType: epType,
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
          id: generateId(),
          name: `${label} → ${timing.name}`,
          description: `${timing.description} for ${label}`,
          category: "timing",
          priority: basePriority,
          endpoint: { method: endpoint.method, pattern: endpoint.pattern },
          endpointType: epType,
          effect: { type: "latency", ms: timing.ms, distribution: timing.distribution },
        });
      }

      scenarios.push({
        id: generateId(),
        name: `${label} → Timeout`,
        description: `Request times out for ${label}`,
        category: "timing",
        priority: basePriority + 1,
        endpoint: { method: endpoint.method, pattern: endpoint.pattern },
        endpointType: epType,
        effect: { type: "timeout", rate: 1.0, afterMs: 30000 },
      });
    }

    if (effectiveCategories.includes("empty")) {
      scenarios.push({
        id: generateId(),
        name: `${label} → Empty Response`,
        description: `Returns empty body for ${label}`,
        category: "empty",
        priority: basePriority,
        endpoint: { method: endpoint.method, pattern: endpoint.pattern },
        endpointType: epType,
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
          id: generateId(),
          name: `${label} → Corrupted Fields`,
          description: `Nullifies key fields in ${label} response`,
          category: "corruption",
          priority: basePriority,
          endpoint: { method: endpoint.method, pattern: endpoint.pattern },
          endpointType: epType,
          effect: { type: "corrupt", mutations },
        });
      }
    }
  }

  return scenarios.sort((a, b) => b.priority - a.priority);
}
