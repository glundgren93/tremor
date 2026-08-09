import { describe, expect, it } from "vitest";
import { parseRoutes, planRouteOwnership, roundRobin, scenarioDedupKey } from "../src/cli/routes";
import type { Scenario } from "../src/types/chaos";

const scenario = (id: string, status = 503): Scenario => ({
  id,
  name: id,
  description: id,
  category: "error",
  priority: 1,
  endpoint: { method: "GET", pattern: "https://app.test/api" },
  endpointType: "api",
  mock: { status, statusText: "x", headers: { b: "2", a: "1" }, body: "body", delay: 0 },
});

describe("routes", () => {
  it("resolves an ordered complete list against origin", () =>
    expect(parseRoutes(" /dashboard,/reports ", "https://app.test/start?q=secret")).toEqual([
      { id: "r01", path: "/dashboard", url: "https://app.test/dashboard" },
      { id: "r02", path: "/reports", url: "https://app.test/reports" },
    ]));
  it.each([
    "",
    "/a,",
    "//evil.test/x",
    "/a?q=1",
    "/a#x",
    "/white space",
    "/a,/./a",
    "/%2f%2fevil",
    "/%5c",
    "/%00",
    "/../x",
    "/./x",
    "/\\evil",
  ])("rejects invalid %j", (value) =>
    expect(() => parseRoutes(value, "https://app.test")).toThrow());
  it("caps routes", () =>
    expect(() =>
      parseRoutes(Array.from({ length: 11 }, (_, i) => `/r${i}`).join(","), "https://app.test"),
    ).toThrow(/at most 10/));
  it("deduplicates by complete behavior rather than id", () => {
    const routes = parseRoutes("/a,/b", "https://app.test");
    const planned = planRouteOwnership([
      {
        route: routes[0] as (typeof routes)[number],
        scenarios: [scenario("one"), scenario("different", 500)],
      },
      {
        route: routes[1] as (typeof routes)[number],
        scenarios: [scenario("another"), scenario("unique", 501)],
      },
    ]);
    expect(planned[0]?.owned).toHaveLength(2);
    expect(planned[1]?.aliases).toMatchObject([
      { scenarioId: "another", ownerRouteId: "r01", reason: "deduplicated-to-owner" },
    ]);
    expect(planned[1]?.owned).toHaveLength(1);
    expect(scenarioDedupKey(scenario("one"))).toBe(scenarioDedupKey(scenario("another")));
  });
  it("uses complete behavior while normalizing only unordered resource types and object keys", () => {
    const base = scenario("base");
    base.endpoint.resourceTypes = ["xhr", "fetch", "xhr"];
    const semantic = structuredClone(base);
    semantic.id = "semantic";
    semantic.endpoint.resourceTypes = ["fetch", "xhr"];
    semantic.mock = { ...semantic.mock, headers: { a: "1", b: "2" } };
    expect(scenarioDedupKey(base)).toBe(scenarioDedupKey(semantic));
    for (const changed of [
      { endpoint: { ...base.endpoint, pattern: "https://app.test/api?q=1" } },
      { endpoint: { ...base.endpoint, resourceTypes: ["document"] } },
      { endpointType: "document" as const },
      { effect: { type: "latency" as const, ms: 1, distribution: "fixed" as const } },
      { mock: { ...base.mock, body: "different" } },
    ])
      expect(scenarioDedupKey({ ...base, ...changed })).not.toBe(scenarioDedupKey(base));
  });
  it("allocates globally and fairly", () =>
    expect(
      roundRobin(
        [
          ["a1", "a2"],
          ["b1", "b2"],
        ],
        3,
      ).map((x) => x.value),
    ).toEqual(["a1", "b1", "a2"]));
});
