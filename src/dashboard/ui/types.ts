/** Mirror of server-side types for the dashboard UI */

export type FindingSeverity = "critical" | "major" | "minor" | "good";

export type WebVitalsMetrics = {
  lcp: number | null;
  cls: number | null;
  ttfb: number | null;
  inp: number | null;
};

export type Phase =
  | "launching"
  | "navigating"
  | "capturing"
  | "generating"
  | "testing"
  | "complete"
  | "waiting_for_auth";

export type DashboardFinding = {
  id: string;
  scenarioName: string;
  severity: FindingSeverity;
  description: string;
  screenshot: string | null;
  endpoint: string;
  category: string;
  metrics: WebVitalsMetrics | null;
  endpointType?: string;
  testType?: string;
  recordingPath?: string | null;
};

export type CompleteSummary = {
  score: number;
  total: number;
  findings: { critical: number; major: number; minor: number; good: number };
  recommendations: string[];
};

export type ScenarioItem = {
  id: string;
  name: string;
  description: string;
  category: "error" | "timing" | "empty" | "corruption";
  endpoint: string;
  priority: number;
  endpointType?: string;
};

export type AgentEntry = {
  id: number;
  kind: "thinking" | "tool_call";
  text: string;
  toolName?: string;
  workerId?: number;
};

export type TestConfig = {
  presets: string[];
  scenarioCount: number;
  exploratory: boolean;
  cpuProfile?: string;
};

export type Report = {
  url: string;
  timestamp: number;
  score: number;
  summary: CompleteSummary | null;
  findings: DashboardFinding[];
  testConfig?: TestConfig;
};

export type ReportListItem = {
  id: string;
  url: string;
  timestamp: number;
  score: number;
  findingCounts: { critical: number; major: number; minor: number; good: number };
  testConfig?: TestConfig;
};

export type ScenarioFileItem = {
  file: string;
  url: string;
  filter?: string;
  savedAt: number;
  scenarioCount: number;
};
