import { describe, expect, it } from "vitest";
import {
  mergeProofArtifacts,
  normalizeBudgetArgs,
  pickScenarios,
  selectProofCandidates,
} from "../src/cli/commands";
import type { ProbeOutcome } from "../src/cli/probe";
import type { Scenario } from "../src/types/chaos";
import { createObservation } from "../src/types/observation";

function outcome(overrides: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    scenario: {
      id: "s1",
      name: "GET /api/items → 503",
      category: "error",
      endpoint: "GET /api/items",
    },
    appeared: [],
    disappeared: [],
    unchangedCount: 0,
    receipts: [],
    matchedCount: 0,
    appliedCount: 0,
    proof: { baselineShot: null, faultedShot: null, video: null },
    error: null,
    ...overrides,
  };
}

function scenario(path: string, status: number, overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: `${path}-${status}`,
    name: `GET ${path} → ${status}`,
    description: "",
    category: "error",
    priority: 1,
    endpoint: {
      method: "GET",
      pattern: `https://app.test${path}`,
      resourceTypes: ["xhr"],
    },
    endpointType: "api",
    mock: {
      status,
      statusText: String(status),
      headers: { "content-type": "application/json" },
      body: "{}",
      delay: 0,
    },
    ...overrides,
  };
}

describe("normalizeBudgetArgs", () => {
  it("uses smoke defaults and allows zero proof reruns", () => {
    expect(normalizeBudgetArgs({}, { budget: false, scenarios: false })).toEqual({
      count: 3,
      proofLimit: 2,
    });
    expect(
      normalizeBudgetArgs({ budget: "4", proofLimit: "0" }, { budget: true, scenarios: false }),
    ).toEqual({ count: 4, proofLimit: 0 });
  });

  it("rejects conflicting and invalid budget options", () => {
    expect(() =>
      normalizeBudgetArgs({ budget: "3", scenarios: "3" }, { budget: true, scenarios: true }),
    ).toThrow("cannot be combined");
    expect(() => normalizeBudgetArgs({ budget: "0" }, { budget: true, scenarios: false })).toThrow(
      "positive integer",
    );
    expect(() =>
      normalizeBudgetArgs({ proofLimit: "-1" }, { budget: false, scenarios: false }),
    ).toThrow("non-negative integer");
  });
});

describe("proof budgeting", () => {
  const delta = createObservation({ kind: "content.error", summary: "error appeared" });

  it("selects only applied, changed, error-free outcomes up to the limit", () => {
    const candidates = selectProofCandidates(
      [
        outcome({ appliedCount: 1, appeared: [delta] }),
        outcome({ appliedCount: 1, disappeared: ["items"] }),
        outcome({ appliedCount: 1 }),
        outcome({ appliedCount: 0, appeared: [delta] }),
        outcome({ appliedCount: 1, appeared: [delta], error: "navigation failed" }),
        outcome({
          appliedCount: 1,
          appeared: [delta],
          receipts: [
            {
              version: 1,
              status: "error",
              scenarioId: "s1",
              faultId: "s1",
              method: "GET",
              url: "https://app.test/api/items",
              resourceType: "xhr",
              timestamp: 1,
            },
          ],
        }),
      ],
      2,
    );
    expect(candidates.map((candidate) => candidate.index)).toEqual([0, 1]);
    expect(selectProofCandidates([outcome({ appliedCount: 1, appeared: [delta] })], 0)).toEqual([]);
  });

  it("merges only successful proof artifacts and preserves smoke evidence", () => {
    const smoke = [outcome({ appliedCount: 1, appeared: [delta] })];
    const originalReceipts = smoke[0]?.receipts;
    mergeProofArtifacts(
      smoke,
      [{ index: 0 }],
      [
        outcome({
          appliedCount: 1,
          proof: { baselineShot: "baseline.png", faultedShot: "faulted.png", video: "proof.webm" },
        }),
      ],
    );
    expect(smoke[0]?.proof).toEqual({
      baselineShot: "baseline.png",
      faultedShot: "faulted.png",
      video: "proof.webm",
    });
    expect(smoke[0]?.receipts).toBe(originalReceipts);

    const failedSmoke = [outcome({ appliedCount: 1, appeared: [delta] })];
    mergeProofArtifacts(failedSmoke, [{ index: 0 }], [outcome({ appliedCount: 0 })]);
    expect(failedSmoke[0]?.proof.video).toBeNull();
  });
});

describe("safe default selection", () => {
  it("selects deterministic 503 scenarios spread across safe endpoints", () => {
    const selected = pickScenarios(
      [
        scenario("/api/items", 500),
        scenario("/api/items", 503),
        scenario("/api/users", 503),
        scenario("/api/orders", 503),
        scenario("/api/foreign", 503, {
          endpoint: {
            method: "GET",
            pattern: "https://other.test/api/foreign",
            resourceTypes: ["xhr"],
          },
        }),
        scenario("/api/post", 503, {
          endpoint: {
            method: "POST",
            pattern: "https://app.test/api/post",
            resourceTypes: ["fetch"],
          },
        }),
      ],
      ["error"],
      3,
      "https://app.test/dashboard",
    );

    expect(selected).toHaveLength(3);
    expect(selected.every((item) => item.mock?.status === 503)).toBe(true);
    expect(selected.map((item) => item.endpoint.pattern)).toEqual([
      "https://app.test/api/items",
      "https://app.test/api/orders",
      "https://app.test/api/users",
    ]);
  });

  it("accepts attested same-site business APIs and rejects unsafe or noisy targets", () => {
    const selected = pickScenarios(
      [
        scenario("/accounts/csrf_meta.json", 503),
        scenario("/api/prices", 503),
        scenario("/content/feed", 503, {
          endpoint: {
            method: "GET",
            pattern: "https://api.app.test/content/feed",
            resourceTypes: ["fetch"],
            party: "same-site",
            replayed: true,
          },
        }),
        scenario("/api/cross", 503, {
          endpoint: {
            method: "GET",
            pattern: "https://other.test/api/cross",
            resourceTypes: ["fetch"],
            party: "cross-site",
            replayed: true,
          },
        }),
        scenario("/api/once", 503, {
          endpoint: {
            method: "GET",
            pattern: "https://app.test/api/once",
            resourceTypes: ["fetch"],
            party: "same-origin",
            replayed: false,
          },
        }),
        scenario("/api/prefetch", 503, {
          endpoint: {
            method: "GET",
            pattern: "https://app.test/api/prefetch",
            resourceTypes: ["fetch"],
            party: "same-origin",
            replayed: true,
            speculative: true,
          },
        }),
      ],
      ["error"],
      5,
      "https://app.test/",
    );

    expect(selected.map((item) => item.endpoint.pattern)).toEqual([
      "https://app.test/api/prices",
      "https://api.app.test/content/feed",
    ]);
  });

  it("selects only the explicit fixed 1000ms latency variant", () => {
    const latency = (path: string, ms: number, overrides: Partial<Scenario> = {}) =>
      scenario(path, 503, {
        category: "timing",
        mock: undefined,
        effect: { type: "latency", ms, distribution: "fixed" },
        endpoint: {
          method: "GET",
          pattern: `https://app.test${path}`,
          resourceTypes: ["fetch"],
          party: "same-origin",
          replayed: true,
        },
        ...overrides,
      });
    const selected = pickScenarios(
      [
        latency("/api/items", 1000),
        latency("/api/items", 3000),
        latency("/api/once", 1000, {
          endpoint: {
            method: "GET",
            pattern: "https://app.test/api/once",
            resourceTypes: ["xhr"],
            party: "same-origin",
            replayed: false,
          },
        }),
      ],
      ["timing"],
      3,
      "https://app.test/",
      "latency",
    );
    expect(selected).toHaveLength(1);
    expect(selected[0]?.effect).toEqual({ type: "latency", ms: 1000, distribution: "fixed" });
  });

  it("orders equal candidates deterministically regardless of discovery order", () => {
    const candidates = [
      scenario("/api/users", 503),
      scenario("/api/items", 503),
      scenario("/api/orders", 503),
    ];
    expect(pickScenarios(candidates, ["error"], 3, "https://app.test/")).toEqual(
      pickScenarios([...candidates].reverse(), ["error"], 3, "https://app.test/"),
    );
  });
});
