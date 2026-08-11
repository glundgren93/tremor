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
const FIRST_PARTY_BOOST = 10;
const AUTH_PATTERNS = [/auth/i, /login/i, /token/i, /session/i, /oauth/i];

function endpointPriority(endpoint: Endpoint): number {
  let priority = PRIORITY_METHODS[endpoint.method] ?? 1;
  if (AUTH_PATTERNS.some((p) => p.test(endpoint.pattern))) priority += 2;
  if (endpoint.firstParty !== false) priority += FIRST_PARTY_BOOST;
  return priority;
}
function endpointLabel(method: HttpMethod, pattern: string): string {
  try {
    return `${method} ${new URL(pattern).pathname}`;
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
type Context = {
  endpoint: Endpoint;
  label: string;
  endpointType: EndpointType;
  priority: number;
  makeId: (kind: string, index: number) => string;
};
function base(
  context: Context,
  category: Scenario["category"],
  name: string,
  description: string,
  priority = context.priority,
): Scenario {
  return {
    id: context.makeId(category, 0),
    name,
    description,
    category,
    priority,
    endpoint: scenarioEndpoint(context.endpoint),
    endpointType: context.endpointType,
    ...journeyMetadata(context.endpoint),
  } as Scenario;
}
function errorScenarios(c: Context): Scenario[] {
  return ERROR_SCENARIOS.map((err) => ({
    ...base(
      c,
      "error",
      `${c.label} → ${err.name}`,
      `${err.description} for ${c.label}`,
      c.priority + 1,
    ),
    id: c.makeId("error", err.status),
    mock: {
      status: err.status,
      statusText: err.name,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: err.name }),
      delay: 0,
    },
  }));
}
function timingScenarios(c: Context): Scenario[] {
  const delays: Scenario[] = TIMING_SCENARIOS.map((timing) => ({
    ...base(c, "timing", `${c.label} → ${timing.name}`, `${timing.description} for ${c.label}`),
    id: c.makeId("timing", timing.ms),
    effect: { type: "latency" as const, ms: timing.ms, distribution: timing.distribution },
  }));
  delays.push({
    ...base(
      c,
      "timing",
      `${c.label} → Timeout`,
      `Request times out for ${c.label}`,
      c.priority + 1,
    ),
    id: c.makeId("timeout", 2),
    effect: { type: "timeout", rate: 1, afterMs: 30000 },
  });
  return delays;
}
function emptyScenario(c: Context): Scenario {
  const body = c.endpoint.sampleResponse?.body?.startsWith("[") ? "[]" : "{}";
  return {
    ...base(c, "empty", `${c.label} → Empty Response`, `Returns empty body for ${c.label}`),
    id: c.makeId("empty", 3),
    mock: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body,
      delay: 0,
    },
  };
}
function corruptionScenario(c: Context): Scenario | undefined {
  const body = c.endpoint.sampleResponse?.body;
  if (!body) return undefined;
  const fields = walkJson(body).filter((f) => f.type !== "object");
  if (!fields.length) return undefined;
  const mutations = fields.slice(0, 5).map((f) => ({ field: f.path, action: "nullify" as const }));
  return {
    ...base(c, "corruption", `${c.label} → Corrupted Fields`, `Nullifies key fields in ${c.label}`),
    id: c.makeId("corruption", fields.length),
    effect: { type: "corrupt", mutations },
  };
}

export interface GenerateScenariosOptions {
  categories?: ("error" | "timing" | "empty" | "corruption")[];
  seed?: string;
}
function scenariosForEndpoint(
  endpoint: Endpoint,
  categories: NonNullable<GenerateScenariosOptions["categories"]>,
  seed: string,
): Scenario[] {
  if (endpoint.method !== "GET") return [];
  const context: Context = {
    endpoint,
    label: endpointLabel(endpoint.method, endpoint.pattern),
    endpointType: endpoint.endpointType ?? "api",
    priority: endpointPriority(endpoint),
    makeId: (kind, index) =>
      stableId(
        endpoint.journeyId
          ? `${kind}:${endpoint.journeyId}:${endpoint.checkpointId ?? ""}:${endpoint.observedStepId ?? ""}:${endpoint.method}:${endpoint.pattern}:${endpoint.resourceTypes?.join(",") ?? ""}:${index}`
          : `${kind}:${endpoint.method}:${endpoint.pattern}:${endpoint.resourceTypes?.join(",") ?? ""}:${index}`,
        seed,
      ),
  };
  const allowed =
    context.endpointType === "document" ? categories.filter((c) => c === "timing") : categories;
  return [
    ...(allowed.includes("error") ? errorScenarios(context) : []),
    ...(allowed.includes("timing") ? timingScenarios(context) : []),
    ...(allowed.includes("empty") ? [emptyScenario(context)] : []),
    ...(allowed.includes("corruption")
      ? [corruptionScenario(context)].filter((s): s is Scenario => !!s)
      : []),
  ];
}

export function generateScenarios(
  endpoints: Endpoint[],
  options?: GenerateScenariosOptions,
): Scenario[] {
  const categories = options?.categories ?? ["error", "timing", "empty", "corruption"];
  const seed = options?.seed ?? "tremor-default-seed";
  return endpoints
    .flatMap((endpoint) => scenariosForEndpoint(endpoint, categories, seed))
    .sort((a, b) => b.priority - a.priority);
}
