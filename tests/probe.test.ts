import { describe, expect, it } from "vitest";
import { observationFingerprint } from "../src/cli/probe";
import type { Observation } from "../src/types/observation";

function observation(facts: Record<string, unknown>): Observation {
  return {
    id: "obs-1",
    kind: "content.sample",
    summary: "sample",
    facts,
    target: { selector: "#result", url: "https://app.test/" },
    evidence: [],
    observedAt: 1,
  };
}

describe("observationFingerprint", () => {
  it("normalizes volatile timestamps, UUIDs, counters, whitespace, and key order", () => {
    const first = observation({
      text: "Updated 2026-08-08T18:00:00.000Z   run 123456",
      requestId: "123e4567-e89b-12d3-a456-426614174000",
      nested: { b: 2, a: 1 },
    });
    const second = observation({
      nested: { a: 1, b: 2 },
      requestId: "987e6543-e21b-12d3-a456-426614174999",
      text: "Updated 2027-09-09T19:01:02Z run 987654321",
    });

    expect(observationFingerprint(first)).toBe(observationFingerprint(second));
  });

  it("detects meaningful fact changes on the same kind and selector", () => {
    expect(observationFingerprint(observation({ clippedByPx: 20 }))).not.toBe(
      observationFingerprint(observation({ clippedByPx: 240 })),
    );
  });
});
