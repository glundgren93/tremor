import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseLiveArgs, selectLiveCase } from "../benchmarks/live-policy.mjs";

const matrix = JSON.parse(
  await readFile(new URL("../benchmarks/matrix.json", import.meta.url), "utf8"),
);
describe("benchmark matrix and live policy", () => {
  it("has distinct, complete, bounded required cases", () => {
    expect(matrix.schemaVersion).toBe(2);
    expect(new Set(matrix.cases.map((x: { id: string }) => x.id)).size).toBe(matrix.cases.length);
    expect(
      matrix.cases
        .filter((x: { required: boolean }) => x.required)
        .map((x: { id: string }) => x.id),
    ).toEqual([
      "static-document",
      "ssr-document",
      "public-spa-retry",
      "blank-panel",
      "authenticated-spa",
      "oauth-expired",
      "same-site-api",
      "safety-business",
      "safety-forbidden-only",
    ]);
    const contracts = matrix.cases.flatMap((c: { contracts: string[] }) => c.contracts);
    for (const contract of [
      "static",
      "SSR",
      "public-page-load-SPA",
      "authenticated-SPA",
      "same-site-API",
      "OAuth/login-expiry",
      "loading",
      "retry",
      "error",
      "blank",
      "third-party-never-fault",
      "telemetry-never-fault",
      "mutation-never-fault",
      "speculative-never-fault",
      "document-never-fault",
    ])
      expect(contracts).toContain(contract);
    expect(matrix.defaults).toMatchObject({
      budget: 1,
      proofLimit: 1,
      video: false,
      runtimeCeilingMs: 25_000,
      selectedMax: 1,
      maxWebm: 0,
    });
    for (const c of matrix.cases) {
      expect(c.sentinels).toBeInstanceOf(Array);
      if (c.required) {
        expect(c.kind).toBe("local");
        expect(c.reviewRequired).toBe(false);
        expect(c.expected).toBeTruthy();
        expect(c.expected.exitCode).toBeGreaterThanOrEqual(0);
        expect(c.expected.exactPng).toBeLessThanOrEqual(2);
        expect(c.expected.maxWebm).toBe(0);
        expect(c.sentinels.length).toBeGreaterThan(0);
      }
      if (c.kind === "live") {
        expect(c.required).toBe(false);
        expect(c.reviewRequired).toBe(true);
        expect(c.auth).not.toBe(true);
      }
    }
  });
  it("parses live arguments without side effects and enforces allowlist", () => {
    expect(
      parseLiveArgs(["--case", "example-live", "--out", "somewhere", "--strict-operational"]),
    ).toMatchObject({ caseId: "example-live", strict: true });
    expect(parseLiveArgs(["--case", "example-live"]).out).toMatch(/tremor-live$/);
    expect(() => parseLiveArgs(["--out"])).toThrow();
    expect(() => parseLiveArgs(["positional"])).toThrow();
    expect(() => parseLiveArgs(["--unknown"])).toThrow();
    expect(selectLiveCase(matrix, "example-live")?.url).toBe("https://example.com");
    expect(selectLiveCase(matrix, "authenticated-spa")).toBeNull();
  });
});
