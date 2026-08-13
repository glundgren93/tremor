import type { AuthSelection } from "../auth/guard";
import type { CpuProfile } from "../capture/cpu-profiles";
import type { WaitUntil } from "../driver/driver";
import type { JourneyFile, JourneyReceipt } from "../journey";
import type { Endpoint, Scenario } from "../types/chaos";
import type { Observation, ObservationSet } from "../types/observation";
import type { DiscoverOutput } from "./discover";
import type { ProbeOutcome } from "./probe";
import type { RouteAlias, RouteRef } from "./routes";

export type CommonOptions = {
  url: string;
  runDir: string;
  headless: boolean;
  waitUntil: WaitUntil;
  timeoutMs: number;
  viewport: { width: number; height: number };
  video: boolean;
  cpu?: CpuProfile;
  authState?: string;
  authSelection?: AuthSelection;
  seed?: string;
  journey?: JourneyFile;
  routes?: RouteRef[];
  route?: RouteRef;
};
export type ScenarioCategory = Scenario["category"];
export type ScanOutput = {
  endpoints: Endpoint[];
  scenarios: Scenario[];
  exchangeCount: number;
  journey?: { id: string; receipts: JourneyReceipt[] };
};
export type RouteScanOutput = {
  mode: "routes";
  routes: {
    route: RouteRef;
    scan: ScanOutput & { applicability: "applicable" | "not-applicable" };
    aliases: RouteAlias[];
    ownedScenarioIds: string[];
  }[];
  scanned: { endpoints: number; scenarios: number; exchanges: number };
};
export type ObserveOutput = { sets: ObservationSet[]; observations: Observation[] };
export type { DiscoverOutput };
export type ChaosOutput = {
  outcomes: ProbeOutcome[];
  scanned: { endpoints: number; scenarios: number };
  budget?: { requested: number; smoke: number; proof: number; seed: string };
  journey?: { id: string; receipts: JourneyReceipt[] };
  applicability:
    | { status: "applicable" }
    | { status: "not-applicable"; reason: string; suggestions: string[] };
};
export type RouteChaosOutput = {
  mode: "routes";
  scanned: { endpoints: number; scenarios: number };
  applicability: ChaosOutput["applicability"];
  budget: { requested: number; smoke: number; proofLimit: number; proof: number; seed: string };
  routes: {
    route: RouteRef;
    scanned: { endpoints: number; scenarios: number; exchanges: number };
    applicability: ChaosOutput["applicability"];
    budget: { eligible: number; owned: number; deduplicated: number; smoke: number; proof: number };
    aliases: RouteAlias[];
    outcomes: ProbeOutcome[];
  }[];
};
