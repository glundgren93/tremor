/**
 * The stdout digest.
 *
 * Everything this engine produces goes into an agent's context window, so
 * output size is a running cost, not a formatting preference. Measured on
 * globo.com the raw result was 2.86 MB for `scan` — 1.56 MB of it captured
 * response bodies that exist only to seed corruption faults and are useless to
 * a reader.
 *
 * So: stdout carries the smallest thing a caller can act on, and `result.json`
 * in the run directory keeps the whole thing for when they need it. `--full`
 * prints the unabridged payload instead.
 */

import type { Endpoint, Scenario } from "../types/chaos";
import type { Observation } from "../types/observation";
import type { ChaosOutput, RouteChaosOutput, RouteScanOutput } from "./commands";

const TOP_N = 10;
const TEXT_SAMPLE_MAX = 80;

/** Facts that are large and rarely change a judgement. Kept in result.json. */
const HEAVY_FACTS = new Set(["rect", "sampleSelectors", "scanned", "src"]);

export type CompactObservation = {
  kind: string;
  summary: string;
  selector: string | null;
  facts: Record<string, unknown>;
  evidence: string[];
};

export function compactObservation(o: Observation): CompactObservation {
  const facts: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o.facts)) {
    if (HEAVY_FACTS.has(k)) continue;
    facts[k] =
      typeof v === "string" && v.length > TEXT_SAMPLE_MAX ? `${v.slice(0, TEXT_SAMPLE_MAX)}…` : v;
  }
  return {
    kind: o.kind,
    summary: o.summary,
    selector: o.target.selector,
    facts,
    evidence: o.evidence.flatMap((e) =>
      e.kind === "screenshot" || e.kind === "video" || e.kind === "trace" ? [e.path] : [],
    ),
  };
}

export type ScanDigest = {
  endpoints: { total: number; firstParty: number; api: number; document: number };
  topEndpoints: string[];
  scenarios: { total: number; byCategory: Record<string, number> };
  topScenarios: string[];
  exchangeCount: number;
};

export function digestRouteScan(output: RouteScanOutput) {
  return {
    mode: "routes" as const,
    scanned: output.scanned,
    routes: output.routes.slice(0, TOP_N).map(({ route, scan, aliases, ownedScenarioIds }) => ({
      route: { id: route.id, path: route.path },
      applicability: scan.applicability,
      ownedScenarioIds: ownedScenarioIds.slice(0, TOP_N),
      aliases: aliases.slice(0, TOP_N),
      ...digestScan(scan.endpoints, scan.scenarios, scan.exchangeCount),
    })),
  };
}

export function digestScan(
  endpoints: Endpoint[],
  scenarios: Scenario[],
  exchangeCount: number,
): ScanDigest {
  const byCategory: Record<string, number> = {};
  for (const s of scenarios) byCategory[s.category] = (byCategory[s.category] ?? 0) + 1;

  return {
    endpoints: {
      total: endpoints.length,
      firstParty: endpoints.filter((e) => e.firstParty).length,
      api: endpoints.filter((e) => e.endpointType === "api").length,
      document: endpoints.filter((e) => e.endpointType === "document").length,
    },
    // Response bodies deliberately absent — they are fault-seeding input.
    topEndpoints: [...endpoints]
      .sort((a, b) => Number(b.firstParty) - Number(a.firstParty) || b.hitCount - a.hitCount)
      .slice(0, TOP_N)
      .map(
        (e) =>
          `${e.method} ${path(e.pattern)} · ${e.hitCount} hits · ${e.firstParty ? "1st" : "3rd"}-party`,
      ),
    scenarios: { total: scenarios.length, byCategory },
    topScenarios: scenarios.slice(0, TOP_N).map((s) => `${s.category}: ${s.name}`),
    exchangeCount,
  };
}

export type ChaosDigest = {
  budget: ChaosOutput["budget"];
  scanned: { endpoints: number; scenarios: number };
  applicability: ChaosOutput["applicability"];
  probed: number;
  /** Scenarios whose faults changed something. Read these first. */
  changed: {
    scenario: string;
    category: string;
    endpoint: string;
    appeared: CompactObservation[];
    disappeared: string[];
    appearedCount: { total: number; omitted: number };
    disappearedCount: { total: number; omitted: number };
    proof: { baseline: string | null; faulted: string | null; video: string | null };
    error: string | null;
    matchedCount: number;
    appliedCount: number;
  }[];
  /** Named, not detailed: a fault that changed nothing is worth knowing about
   *  but not worth paying tokens to describe. */
  unchanged: string[];
  notApplied: { scenario: string; reason: "never-matched" | "not-fired" }[];
  failed: { scenario: string; error: string }[];
  totals: Record<
    "changed" | "unchanged" | "notApplied" | "failed",
    { total: number; omitted: number }
  >;
};

export function digestChaos(output: ChaosOutput): ChaosDigest {
  const changed: ChaosDigest["changed"] = [];
  const unchanged: string[] = [];
  const notApplied: ChaosDigest["notApplied"] = [];
  const failed: ChaosDigest["failed"] = [];

  for (const o of output.outcomes) {
    if (!o) continue;
    const moved = o.appeared.length > 0 || o.disappeared.length > 0;
    if (o.error || (o.receipts ?? []).some((r) => r.status === "error")) {
      failed.push({ scenario: o.scenario.name, error: o.error ?? "fault application error" });
      continue;
    }
    if (o.appliedCount === 0) {
      notApplied.push({
        scenario: o.scenario.name,
        reason: o.matchedCount === 0 ? "never-matched" : "not-fired",
      });
      continue;
    }
    if (!moved) {
      unchanged.push(o.scenario.name);
      continue;
    }
    changed.push({
      scenario: o.scenario.name,
      category: o.scenario.category,
      endpoint: o.scenario.endpoint,
      appeared: o.appeared.slice(0, TOP_N).map(compactObservation),
      disappeared: o.disappeared.slice(0, TOP_N),
      appearedCount: { total: o.appeared.length, omitted: Math.max(0, o.appeared.length - TOP_N) },
      disappearedCount: {
        total: o.disappeared.length,
        omitted: Math.max(0, o.disappeared.length - TOP_N),
      },
      proof: {
        baseline: o.proof.baselineShot,
        faulted: o.proof.faultedShot,
        video: o.proof.video,
      },
      error: o.error,
      matchedCount: Math.min(o.matchedCount, 1000),
      appliedCount: Math.min(o.appliedCount, 1000),
    });
  }

  return {
    budget: output.budget ?? {
      requested: output.outcomes.length,
      smoke: output.outcomes.length,
      proof: 0,
      seed: "",
    },
    scanned: output.scanned,
    applicability: output.applicability,
    probed: output.outcomes.filter(Boolean).length,
    changed: changed.slice(0, TOP_N),
    unchanged: unchanged.slice(0, TOP_N),
    notApplied: notApplied.slice(0, TOP_N),
    failed: failed.slice(0, TOP_N),
    totals: {
      changed: { total: changed.length, omitted: Math.max(0, changed.length - TOP_N) },
      unchanged: { total: unchanged.length, omitted: Math.max(0, unchanged.length - TOP_N) },
      notApplied: { total: notApplied.length, omitted: Math.max(0, notApplied.length - TOP_N) },
      failed: { total: failed.length, omitted: Math.max(0, failed.length - TOP_N) },
    },
  };
}

export function digestRouteChaos(output: RouteChaosOutput) {
  const changed: object[] = [],
    unchanged: object[] = [],
    notApplied: object[] = [],
    failed: object[] = [],
    aliases: object[] = [];
  const totals = { changed: 0, unchanged: 0, notApplied: 0, failed: 0, aliases: 0 };
  for (const route of output.routes) {
    const digest = digestChaos({
      outcomes: route.outcomes,
      scanned: { endpoints: route.scanned.endpoints, scenarios: route.scanned.scenarios },
      budget: undefined,
      applicability: route.applicability,
    });
    const tag = (item: unknown) => ({
      routeId: route.route.id,
      routePath: route.route.path,
      ...(typeof item === "object" && item ? item : { scenario: item }),
    });
    totals.changed += digest.totals.changed.total;
    totals.unchanged += digest.totals.unchanged.total;
    totals.notApplied += digest.totals.notApplied.total;
    totals.failed += digest.totals.failed.total;
    totals.aliases += route.aliases.length;
    changed.push(...digest.changed.slice(0, Math.max(0, TOP_N - changed.length)).map(tag));
    unchanged.push(...digest.unchanged.slice(0, Math.max(0, TOP_N - unchanged.length)).map(tag));
    notApplied.push(...digest.notApplied.slice(0, Math.max(0, TOP_N - notApplied.length)).map(tag));
    failed.push(...digest.failed.slice(0, Math.max(0, TOP_N - failed.length)).map(tag));
    aliases.push(
      ...route.aliases.slice(0, Math.max(0, TOP_N - aliases.length)).map((alias) =>
        tag({
          scenarioId: alias.scenarioId,
          ownerRouteId: alias.ownerRouteId,
          reason: alias.reason,
        }),
      ),
    );
  }
  return {
    mode: "routes" as const,
    scanned: output.scanned,
    applicability: output.applicability,
    budget: output.budget,
    routes: output.routes.slice(0, TOP_N).map((route) => ({
      route: { id: route.route.id, path: route.route.path },
      scanned: route.scanned,
      applicability: route.applicability,
      budget: route.budget,
    })),
    changed,
    unchanged,
    notApplied,
    failed,
    aliases,
    totals: Object.fromEntries(
      Object.entries(totals).map(([key, total]) => [
        key,
        { total, omitted: Math.max(0, total - TOP_N) },
      ]),
    ),
  };
}

function path(pattern: string): string {
  try {
    const u = new URL(pattern);
    return `${u.host}${u.pathname}`;
  } catch {
    return pattern;
  }
}
