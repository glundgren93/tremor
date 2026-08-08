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
import type { ChaosOutput } from "./commands";

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
  scanned: { endpoints: number; scenarios: number };
  probed: number;
  /** Scenarios whose faults changed something. Read these first. */
  changed: {
    scenario: string;
    category: string;
    endpoint: string;
    appeared: CompactObservation[];
    disappeared: string[];
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
};

export function digestChaos(output: ChaosOutput): ChaosDigest {
  const changed: ChaosDigest["changed"] = [];
  const unchanged: string[] = [];
  const notApplied: ChaosDigest["notApplied"] = [];
  const failed: ChaosDigest["failed"] = [];

  for (const o of output.outcomes) {
    if (!o) continue;
    const moved = o.appeared.length > 0 || o.disappeared.length > 0;
    if (o.error) {
      failed.push({ scenario: o.scenario.name, error: o.error });
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
      appeared: o.appeared.map(compactObservation),
      disappeared: o.disappeared,
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
    scanned: output.scanned,
    probed: output.outcomes.filter(Boolean).length,
    changed,
    unchanged,
    notApplied,
    failed,
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
