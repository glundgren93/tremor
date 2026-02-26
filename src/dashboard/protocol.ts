import type { FindingSeverity, WebVitalsMetrics } from "../core/types";

/** Scenario item sent to the client for selection */
export type ScenarioItem = {
  id: string;
  name: string;
  description: string;
  category: "error" | "timing" | "empty" | "corruption";
  endpoint: string;
  priority: number;
  endpointType?: string;
};

/** Messages sent from the client to the server */
export type ClientMessage =
  | { type: "start_test"; url: string; requiresAuth?: boolean; filter?: string; scenarioFile?: string; scenarioIds?: string[]; presets?: string[]; exploratory?: boolean; cpuProfile?: string }
  | { type: "start_testing"; scenarioIds: string[]; presets: string[]; exploratory?: boolean; cpuProfile?: string }
  | { type: "stop_test" }
  | { type: "auth_ready" }
  | { type: "input_click"; x: number; y: number }
  | { type: "input_key"; key: string }
  | { type: "input_type"; text: string }
  | { type: "switch_worker"; workerId: number }
  | { type: "save_scenarios"; name?: string };

/** Messages sent from the server to the client */
export type ServerMessage =
  | { type: "status"; phase: Phase }
  | { type: "screenshot"; data: string }
  | { type: "finding"; finding: DashboardFinding }
  | { type: "progress"; current: number; total: number }
  | { type: "endpoints_discovered"; count: number; endpoints: string[] }
  | { type: "scenarios_generated"; count: number; byCategory: Record<string, number> }
  | { type: "score"; value: number }
  | { type: "scenarios_list"; scenarios: ScenarioItem[] }
  | { type: "error"; message: string }
  | { type: "complete"; summary: CompleteSummary }
  | { type: "agent_thinking"; text: string; workerId?: number }
  | { type: "tool_call"; tool: string; args: Record<string, unknown>; workerId?: number }
  | { type: "workers_started"; count: number }
  | { type: "worker_switched"; workerId: number }
  | { type: "scenarios_saved"; file: string; count: number }
  | { type: "scenario_files"; files: ScenarioFileItem[] };

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
  recordingPath: string | null;
};

export type CompleteSummary = {
  score: number;
  total: number;
  findings: { critical: number; major: number; minor: number; good: number };
  recommendations: string[];
};

export type ScenarioFileItem = {
  file: string;
  url: string;
  filter?: string;
  savedAt: number;
  scenarioCount: number;
};
