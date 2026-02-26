import { describe, expect, it } from "vitest";
import {
  consolidateFindings,
  extractSignatureWords,
  findCommonPathPrefix,
  wordOverlap,
} from "../src/core/consolidation";
import type { Finding } from "../src/core/types";

function makeFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: `finding-${Math.random().toString(36).slice(2, 8)}`,
    scenarioName: "GET /api/data → Empty Response",
    severity: "good",
    description: "The page gracefully handles the empty API response with a fallback message.",
    screenshotPath: null,
    endpoint: "GET https://example.com/api/data",
    category: "empty",
    metrics: null,
    timestamp: Date.now(),
    endpointType: "api",
    testType: "initial-load",
    ...overrides,
  };
}

describe("extractSignatureWords", () => {
  it("extracts meaningful words and strips URLs/numbers", () => {
    const words = extractSignatureWords(
      "The page at https://example.com/api returned 200 with graceful fallback message",
    );
    expect(words.has("page")).toBe(true);
    expect(words.has("graceful")).toBe(true);
    expect(words.has("fallback")).toBe(true);
    expect(words.has("200")).toBe(false);
    expect(words.has("https")).toBe(false);
  });

  it("returns empty set for empty string", () => {
    expect(extractSignatureWords("").size).toBe(0);
  });
});

describe("wordOverlap", () => {
  it("returns 1 for identical descriptions", () => {
    const desc = "The page gracefully handles the empty response";
    expect(wordOverlap(desc, desc)).toBe(1);
  });

  it("returns high overlap for similar descriptions", () => {
    const a = "The page gracefully handles the empty API response with a fallback message";
    const b = "The page gracefully handles the empty data response with a fallback display";
    expect(wordOverlap(a, b)).toBeGreaterThan(0.6);
  });

  it("returns low overlap for different descriptions", () => {
    const a = "Blank white screen with no content visible";
    const b = "The page gracefully handles the empty response with a fallback message";
    expect(wordOverlap(a, b)).toBeLessThan(0.3);
  });

  it("returns 0 for empty strings", () => {
    expect(wordOverlap("", "something")).toBe(0);
    expect(wordOverlap("something", "")).toBe(0);
  });
});

describe("findCommonPathPrefix", () => {
  it("finds common prefix for similar paths", () => {
    const result = findCommonPathPrefix([
      "GET https://example.com/_next/data/abc/posts/1.json",
      "GET https://example.com/_next/data/abc/posts/2.json",
      "GET https://example.com/_next/data/abc/posts/3.json",
    ]);
    expect(result).toContain("/_next/data");
  });

  it("returns the single endpoint for one item", () => {
    const result = findCommonPathPrefix(["GET https://example.com/api/users"]);
    expect(result).toBe("GET https://example.com/api/users");
  });

  it("returns empty string for empty array", () => {
    expect(findCommonPathPrefix([])).toBe("");
  });
});

describe("consolidateFindings", () => {
  it("groups 5 similar findings into 1 group", () => {
    const findings = Array.from({ length: 5 }, (_, i) =>
      makeFinding({
        endpoint: `GET https://example.com/_next/data/abc/posts/${i}.json`,
        scenarioName: `GET /_next/data/abc/posts/${i}.json → Empty Response`,
        description:
          "The page gracefully handles the empty API response with a fallback message displayed to the user.",
      }),
    );
    const result = consolidateFindings(findings);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.count).toBe(5);
    expect(result.ungrouped).toHaveLength(0);
  });

  it("does not group 2 findings (below threshold)", () => {
    const findings = [
      makeFinding({
        endpoint: "GET https://example.com/api/a",
        description:
          "The page gracefully handles the empty API response with a fallback message.",
      }),
      makeFinding({
        endpoint: "GET https://example.com/api/b",
        description:
          "The page gracefully handles the empty API response with a fallback message.",
      }),
    ];
    const result = consolidateFindings(findings);
    expect(result.groups).toHaveLength(0);
    expect(result.ungrouped).toHaveLength(2);
  });

  it("does not group findings with different severity", () => {
    const findings = [
      ...Array.from({ length: 3 }, () =>
        makeFinding({
          severity: "good",
          description:
            "The page gracefully handles the empty response with a fallback message.",
        }),
      ),
      ...Array.from({ length: 3 }, () =>
        makeFinding({
          severity: "critical",
          description:
            "The page gracefully handles the empty response with a fallback message.",
        }),
      ),
    ];
    const result = consolidateFindings(findings);
    expect(result.groups).toHaveLength(2);
  });

  it("does not group findings with different categories", () => {
    const findings = [
      ...Array.from({ length: 3 }, () =>
        makeFinding({
          category: "empty",
          description:
            "The page gracefully handles the empty response with a fallback message.",
        }),
      ),
      ...Array.from({ length: 3 }, () =>
        makeFinding({
          category: "error",
          description:
            "The page gracefully handles the empty response with a fallback message.",
        }),
      ),
    ];
    const result = consolidateFindings(findings);
    expect(result.groups).toHaveLength(2);
  });

  it("does not group findings with very different descriptions", () => {
    const findings = [
      ...Array.from({ length: 3 }, () =>
        makeFinding({
          description:
            "The page gracefully handles the empty response with a fallback message.",
        }),
      ),
      ...Array.from({ length: 3 }, () =>
        makeFinding({
          description: "Blank white screen with no content visible and app is crashed.",
        }),
      ),
    ];
    const result = consolidateFindings(findings);
    // Should be 2 separate groups since descriptions are very different
    expect(result.groups).toHaveLength(2);
  });
});
