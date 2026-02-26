export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";

export type EndpointType = "document" | "api";

export type TestType = "initial-load" | "navigation" | "exploratory";

export type CapturedRequest = {
  id: string;
  timestamp: number;
  method: HttpMethod;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    duration: number;
  };
};

export type RequestMatcher = {
  method?: HttpMethod;
  urlPattern: string;
  headers?: Record<string, string>;
  /** When set, only match requests whose Playwright resourceType is in this list (e.g. ["xhr", "fetch"]). */
  resourceTypes?: string[];
};

export type MockResponse = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  delay: number;
};

export type ChaosEffect =
  | { type: "latency"; ms: number; distribution: "fixed" | "uniform" | "normal" }
  | { type: "error"; status: number; rate: number }
  | { type: "timeout"; rate: number; afterMs: number }
  | { type: "corrupt"; mutations: CorruptMutation[] }
  | { type: "throttle"; bytesPerSecond: number }
  | { type: "mock"; status: number; body: string; rate: number };

export type CorruptMutation =
  | { field: string; action: "remove" }
  | { field: string; action: "nullify" }
  | { field: string; action: "empty" }
  | { field: string; action: "replace"; value: unknown };

export type ChaosPreset = {
  id: string;
  name: string;
  description: string;
  rules: {
    name: string;
    enabled: boolean;
    match: RequestMatcher;
    effects: ChaosEffect[];
    /** When set, this rule fails failCount times then lets requests through. */
    failCount?: number;
  }[];
};

/** Deduplicated endpoint with sample response */
export type Endpoint = {
  method: HttpMethod;
  pattern: string;
  sampleUrl: string;
  sampleResponse: {
    status: number;
    headers: Record<string, string>;
    body: string;
  } | null;
  hitCount: number;
  endpointType: EndpointType;
};

/** Generated fault scenario with match + mock/chaos config */
export type Scenario = {
  id: string;
  name: string;
  description: string;
  category: "error" | "timing" | "empty" | "corruption";
  priority: number;
  endpoint: { method: HttpMethod; pattern: string };
  endpointType: EndpointType;
  mock?: MockResponse;
  effect?: ChaosEffect;
};

/** Walked JSON field with path, type, and value */
export type JsonField = {
  path: string;
  type: "string" | "number" | "boolean" | "null" | "array" | "object";
  value: unknown;
};

/** Core Web Vitals metrics captured from the page */
export type WebVitalsMetrics = {
  lcp: number | null;
  cls: number | null;
  ttfb: number | null;
  inp: number | null;
};

/** Severity of a resilience test finding */
export type FindingSeverity = "critical" | "major" | "minor" | "good";

/** Saved scenario file for reuse */
export type ScenarioFile = {
  version: 1;
  url: string;
  filter?: string;
  savedAt: number;
  scenarios: Scenario[];
};

/** A single finding from resilience testing */
export type Finding = {
  id: string;
  scenarioName: string;
  severity: FindingSeverity;
  description: string;
  screenshotPath: string | null;
  recordingPath: string | null;
  endpoint: string;
  category: string;
  metrics: WebVitalsMetrics | null;
  timestamp: number;
  endpointType: EndpointType;
  testType: TestType;
};
