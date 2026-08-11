import type { Scenario } from "../types/chaos";
import { err, ok, type Result } from "../types/result";
import { pickScenarios, scanOnly } from "./chaos";
import type { ProbeOutcome } from "./probe";
import { deduplicateBaselineShots, probeOne } from "./probe";
import { mergeProofArtifacts, selectProofCandidates } from "./proof";
import { planRouteOwnership, type RouteRef, roundRobin } from "./routes";
import type { CommonOptions, RouteChaosOutput, ScanOutput, ScenarioCategory } from "./types";

async function discoverRouteScenarios(
  opts: CommonOptions,
  filter: string | undefined,
  categories: ScenarioCategory[],
  fault?: "latency",
): Promise<Result<{ route: RouteRef; scan: ScanOutput; eligible: Scenario[] }[]>> {
  const found: { route: RouteRef; scan: ScanOutput; eligible: Scenario[] }[] = [];
  for (const route of opts.routes ?? []) {
    const scanned = await scanOnly(
      {
        ...opts,
        routes: undefined,
        route,
        url: route.url,
        runDir: `${opts.runDir}/routes/${route.id}/scan`,
        video: false,
      },
      filter,
    );
    if (!scanned.ok) return scanned;
    found.push({
      route,
      scan: scanned.value,
      eligible: pickScenarios(
        scanned.value.scenarios,
        fault === "latency" ? ["timing"] : categories,
        Number.MAX_SAFE_INTEGER,
        route.url,
        fault,
      ),
    });
  }
  return ok(found);
}

async function runRoutePlans(
  opts: CommonOptions,
  ownership: ReturnType<typeof planRouteOwnership>,
  plans: { routeIndex: number; value: Scenario; ordinal: number }[],
  concurrency: number,
  mode: "smoke" | "proof",
) {
  const results = new Array<ProbeOutcome>(plans.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, plans.length) }, async () => {
      while (cursor < plans.length) {
        const ordinal = cursor++;
        const plan = plans[ordinal];
        if (!plan) continue;
        const route = ownership[plan.routeIndex]?.route;
        if (!route) continue;
        results[ordinal] = await probeOne(
          {
            ...opts,
            routes: undefined,
            route,
            url: route.url,
            runDir: `${opts.runDir}/routes/${route.id}/probes`,
          },
          plan.value,
          plan.ordinal,
          mode,
        );
      }
    }),
  );
  return results;
}

export async function commandRouteChaos(
  opts: CommonOptions,
  filter: string | undefined,
  categories: ScenarioCategory[],
  count: number,
  concurrency: number,
  proofLimit: number,
  fault?: "latency",
): Promise<Result<RouteChaosOutput>> {
  const discovery = await discoverRouteScenarios(opts, filter, categories, fault);
  if (!discovery.ok) return discovery;
  const discovered = discovery.value;
  const ownership = planRouteOwnership(
    discovered.map(({ route, eligible }) => ({ route, scenarios: eligible })),
  );
  const smokePlans = roundRobin(
    ownership.map((entry) => entry.owned),
    count,
  ).map((plan, ordinal) => ({ ...plan, ordinal }));
  const outcomesByRoute: ProbeOutcome[][] = ownership.map(() => []);
  const runPlans = (plans: typeof smokePlans, mode: "smoke" | "proof") =>
    runRoutePlans(opts, ownership, plans, concurrency, mode);
  const smoke = await runPlans(smokePlans, "smoke");
  const operational = smoke.find(
    (outcome) => outcome.failureKind === "authentication" || outcome.failureKind === "origin",
  );
  if (operational?.error) return err(new Error(operational.error));
  smoke.forEach((outcome, index) => {
    const plan = smokePlans[index];
    if (outcome && plan) outcomesByRoute[plan.routeIndex]?.push(outcome);
  });

  const qualifying = outcomesByRoute.map((outcomes) =>
    selectProofCandidates(outcomes, Number.MAX_SAFE_INTEGER),
  );
  const proofSelections = roundRobin(qualifying, proofLimit);
  const proofPlans = proofSelections.map(({ routeIndex, value }) => {
    const routePlans = smokePlans.filter((plan) => plan.routeIndex === routeIndex);
    const smokePlan = routePlans[value.index];
    if (!smokePlan)
      throw new Error(`Missing smoke plan for route ${routeIndex} proof candidate ${value.index}`);
    return { routeIndex, value: smokePlan.value, ordinal: smokePlan.ordinal };
  });
  const proof = await runPlans(proofPlans, "proof");
  // Baselines are comparable only within a route probe root. Never deduplicate across routes.
  for (let routeIndex = 0; routeIndex < ownership.length; routeIndex++) {
    const route = ownership[routeIndex]?.route;
    if (!route) continue;
    deduplicateBaselineShots(
      proof.filter((_, index) => proofPlans[index]?.routeIndex === routeIndex),
      `${opts.runDir}/routes/${route.id}/probes`,
    );
  }
  const proofOperational = proof.find(
    (outcome) => outcome.failureKind === "authentication" || outcome.failureKind === "origin",
  );
  if (proofOperational?.error) return err(new Error(proofOperational.error));
  // Merge once per route so all accepted canonical baselines are protected before
  // any rejected sibling artifacts are removed.
  for (let routeIndex = 0; routeIndex < ownership.length; routeIndex++) {
    const route = ownership[routeIndex]?.route;
    if (!route) continue;
    const selected = proofSelections
      .map((selection, proofIndex) => ({ selection, proofIndex }))
      .filter(({ selection }) => selection.routeIndex === routeIndex);
    mergeProofArtifacts(
      outcomesByRoute[routeIndex] ?? [],
      selected.map(({ selection }) => ({ index: selection.value.index })),
      selected.map(({ proofIndex }) => proof[proofIndex]).filter((value) => value !== undefined),
      `${opts.runDir}/routes/${route.id}/probes`,
    );
  }

  const routes = ownership.map((entry, routeIndex) => {
    const found = discovered[routeIndex];
    const outcomes = outcomesByRoute[routeIndex] ?? [];
    const proofCount = proofSelections.filter(
      (selection) => selection.routeIndex === routeIndex,
    ).length;
    const applicable = entry.eligible > 0;
    return {
      route: entry.route,
      scanned: {
        endpoints: found?.scan.endpoints.length ?? 0,
        scenarios: found?.scan.scenarios.length ?? 0,
        exchanges: found?.scan.exchangeCount ?? 0,
      },
      applicability: applicable
        ? {
            status: "applicable" as const,
            ...(entry.owned.length === 0
              ? {
                  reason:
                    "Eligible candidates were deduplicated to a representative owner route; this route was not tested.",
                }
              : {}),
          }
        : {
            status: "not-applicable" as const,
            reason: "No eligible repeatable business API scenario was observed.",
            suggestions: ["Run scan to inspect this route's endpoints."],
          },
      budget: {
        eligible: entry.eligible,
        owned: entry.owned.length,
        deduplicated: entry.aliases.length,
        smoke: outcomes.length,
        proof: proofCount,
      },
      aliases: entry.aliases,
      outcomes,
    };
  });
  const anyApplicable = routes.some((route) => route.budget.eligible > 0);
  return ok({
    mode: "routes",
    scanned: {
      endpoints: routes.reduce((sum, route) => sum + route.scanned.endpoints, 0),
      scenarios: routes.reduce((sum, route) => sum + route.scanned.scenarios, 0),
    },
    applicability: anyApplicable
      ? { status: "applicable" }
      : {
          status: "not-applicable",
          reason: "No route contained an eligible scenario.",
          suggestions: ["Run scan to inspect route endpoints."],
        },
    budget: {
      requested: count,
      smoke: smoke.length,
      proofLimit,
      proof: proofSelections.length,
      seed: opts.seed ?? "tremor-default-seed",
    },
    routes,
  });
}
