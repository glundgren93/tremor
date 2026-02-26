import type { BrowserContext, CDPSession, Page, Route } from "playwright";
import { DEFAULT_REDACTION_CONFIG, type RedactionConfig } from "./core/redaction";
import type { CapturedRequest, EndpointType, Finding, Scenario } from "./core/types";

export interface ActiveFault {
  id: string;
  endpoint: string;
  category: string;
  source: "scenario" | "preset" | "custom";
  endpointType?: EndpointType;
  handlers: Array<(route: Route) => Promise<void>>;
}

/** Per-worker state for parallel resilience testing. Each worker gets its own page and fault list. */
export interface WorkerContext {
  page: Page;
  activeFaults: ActiveFault[];
  targetUrl?: string;
  onPageChanged?: (oldPage: Page, newPage: Page) => Promise<void>;
}

export interface TestConfig {
  presets: string[];
  scenarioCount: number;
  exploratory: boolean;
  cpuProfile?: string;
}

export interface ServerState {
  context: BrowserContext | null;
  page: Page | null;
  capturedRequests: CapturedRequest[];
  generatedScenarios: Scenario[];
  activeFaults: ActiveFault[];
  redactionConfig: RedactionConfig;
  findings: Finding[];
  recommendations: string[];
  cpuThrottleRate: number;
  cpuThrottleCdp: CDPSession | null;
  testConfig: TestConfig | null;
}

export const state: ServerState = {
  context: null,
  page: null,
  capturedRequests: [],
  generatedScenarios: [],
  activeFaults: [],
  redactionConfig: { ...DEFAULT_REDACTION_CONFIG },
  findings: [],
  recommendations: [],
  cpuThrottleRate: 1,
  cpuThrottleCdp: null,
  testConfig: null,
};
