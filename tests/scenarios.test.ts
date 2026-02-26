import { describe, expect, it } from "vitest";
import { generateScenarios } from "../src/core/scenarios";
import type { Endpoint } from "../src/core/types";

function makeEndpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return {
    method: "GET",
    pattern: "https://api.example.com/users",
    sampleUrl: "https://api.example.com/users",
    sampleResponse: {
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: 1, name: "Alice", email: "alice@example.com" }),
    },
    hitCount: 1,
    endpointType: "api",
    ...overrides,
  };
}

describe("generateScenarios", () => {
  it("generates error scenarios for an endpoint", () => {
    const scenarios = generateScenarios([makeEndpoint()], { categories: ["error"] });
    expect(scenarios.length).toBe(5); // 500, 503, 404, 401, 429
    expect(scenarios.every((s) => s.category === "error")).toBe(true);
    expect(scenarios.every((s) => s.mock !== undefined)).toBe(true);
  });

  it("generates timing scenarios for an endpoint", () => {
    const scenarios = generateScenarios([makeEndpoint()], { categories: ["timing"] });
    expect(scenarios.length).toBe(3); // 3s, 10s, timeout
    expect(scenarios.every((s) => s.category === "timing")).toBe(true);
  });

  it("generates empty response scenario", () => {
    const scenarios = generateScenarios([makeEndpoint()], { categories: ["empty"] });
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]?.mock?.body).toBe("{}");
  });

  it("generates empty array for array responses", () => {
    const endpoint = makeEndpoint({
      sampleResponse: {
        status: 200,
        headers: {},
        body: JSON.stringify([{ id: 1 }]),
      },
    });
    const scenarios = generateScenarios([endpoint], { categories: ["empty"] });
    expect(scenarios[0]?.mock?.body).toBe("[]");
  });

  it("generates corruption scenarios from JSON fields", () => {
    const scenarios = generateScenarios([makeEndpoint()], { categories: ["corruption"] });
    expect(scenarios).toHaveLength(1);
    expect(scenarios[0]?.effect?.type).toBe("corrupt");
  });

  it("prioritizes POST over GET", () => {
    const endpoints = [
      makeEndpoint({ method: "GET", pattern: "https://api.example.com/users" }),
      makeEndpoint({ method: "POST", pattern: "https://api.example.com/orders" }),
    ];
    const scenarios = generateScenarios(endpoints, { categories: ["error"] });
    // POST scenarios should come first (higher priority)
    const firstPostIndex = scenarios.findIndex((s) => s.endpoint.method === "POST");
    const firstGetIndex = scenarios.findIndex((s) => s.endpoint.method === "GET");
    expect(firstPostIndex).toBeLessThan(firstGetIndex);
  });

  it("boosts auth endpoint priority", () => {
    const endpoints = [
      makeEndpoint({ method: "GET", pattern: "https://api.example.com/users" }),
      makeEndpoint({ method: "GET", pattern: "https://api.example.com/auth/login" }),
    ];
    const scenarios = generateScenarios(endpoints, { categories: ["error"] });
    const authScenario = scenarios.find((s) => s.endpoint.pattern.includes("auth"));
    const userScenario = scenarios.find((s) => s.endpoint.pattern.includes("users"));
    expect(authScenario?.priority).toBeGreaterThan(userScenario?.priority as number);
  });

  it("generates all categories by default", () => {
    const scenarios = generateScenarios([makeEndpoint()]);
    const categories = new Set(scenarios.map((s) => s.category));
    expect(categories).toContain("error");
    expect(categories).toContain("timing");
    expect(categories).toContain("empty");
    expect(categories).toContain("corruption");
  });

  it("returns sorted by priority descending", () => {
    const scenarios = generateScenarios([makeEndpoint()]);
    for (let i = 1; i < scenarios.length; i++) {
      const prev = scenarios[i - 1];
      const curr = scenarios[i];
      expect(prev?.priority).toBeGreaterThanOrEqual(curr?.priority as number);
    }
  });

  it("propagates endpointType to scenarios", () => {
    const scenarios = generateScenarios([makeEndpoint({ endpointType: "api" })]);
    expect(scenarios.every((s) => s.endpointType === "api")).toBe(true);
  });

  it("only generates timing scenarios for document endpoints", () => {
    const endpoint = makeEndpoint({
      pattern: "https://example.com/",
      endpointType: "document",
      sampleResponse: {
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<html></html>",
      },
    });
    const scenarios = generateScenarios([endpoint]);
    expect(scenarios.length).toBe(3); // 3s slow, 10s slow, timeout
    expect(scenarios.every((s) => s.category === "timing")).toBe(true);
    expect(scenarios.every((s) => s.endpointType === "document")).toBe(true);
  });

  it("generates all categories for api endpoints", () => {
    const endpoint = makeEndpoint({ endpointType: "api" });
    const scenarios = generateScenarios([endpoint]);
    const categories = new Set(scenarios.map((s) => s.category));
    expect(categories).toContain("error");
    expect(categories).toContain("timing");
    expect(categories).toContain("empty");
    expect(categories).toContain("corruption");
  });
});
