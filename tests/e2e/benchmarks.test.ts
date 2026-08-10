import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";
import { afterAll, describe, expect, it } from "vitest";

type BenchmarkCase = {
  id: string;
  expectationsMatched: boolean;
  mismatchReasons: string[];
  durationMs: number;
  exitCode: number;
  applicability: string | null;
  mutationStateWrites: number;
  sentinelAbsent: boolean;
  pathContained: boolean;
  privateModes: boolean;
  schemaValid: { stdout: boolean; full: boolean };
  media: { pngCount: number; webmCount: number; mediaBytes: number };
  totalRunBytes: number;
  selectedScenarioPaths: string[];
  observationKinds: string[];
  appliedReceipts: Array<{ path: string; method: string }>;
  serverActivity: Record<string, number>;
  stdoutPath: string;
  resultPath: string | null;
  [key: string]: unknown;
};
type BenchmarkManifest = { schemaVersion: number; cases: BenchmarkCase[] };

const exec = promisify(execFile),
  roots: string[] = [];
const manifests: BenchmarkManifest[] = [];
const envelopeSchema = JSON.parse(
  await readFile(resolve("schemas/cli-envelope-v1.schema.json"), "utf8"),
);
const validate = new Ajv2020({ strict: false }).compile(envelopeSchema);
const expectedIds = [
  "static-document",
  "ssr-document",
  "public-spa-retry",
  "blank-panel",
  "authenticated-spa",
  "oauth-expired",
  "same-site-api",
  "safety-business",
  "safety-forbidden-only",
];
describe("local benchmark repeatability", () => {
  it("runs the corpus twice with identical factual outcomes", async () => {
    for (let i = 0; i < 2; i++) {
      const root = await mkdtemp(join(tmpdir(), `tremor-corpus-${i}-`));
      roots.push(root);
      await exec(process.execPath, ["benchmarks/run-local.mjs", "--", root], {
        cwd: resolve("."),
        timeout: 240_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      manifests.push(
        JSON.parse(await readFile(join(root, "manifest.json"), "utf8")) as BenchmarkManifest,
      );
    }
    for (const [index, m] of manifests.entries()) {
      expect(m.schemaVersion).toBe(2);
      expect(m.cases.map((c) => c.id)).toEqual(expectedIds);
      const expectedPng = [0, 0, 2, 2, 2, 0, 2, 2, 0];
      for (const [caseIndex, c] of m.cases.entries()) {
        expect(c.expectationsMatched, c.mismatchReasons.join(", ")).toBe(true);
        expect(c.mismatchReasons).toEqual([]);
        expect(c.mutationStateWrites).toBe(0);
        expect(c.sentinelAbsent).toBe(true);
        expect(c.pathContained).toBe(true);
        expect(c.privateModes).toBe(true);
        expect(c.schemaValid).toEqual({ stdout: true, full: true });
        expect(c.media.pngCount).toBe(expectedPng[caseIndex]);
        expect(c.media.webmCount).toBe(0);
        expect(c.media.mediaBytes).toBeLessThanOrEqual(5_000_000);
        expect(c.totalRunBytes).toBeLessThanOrEqual(6_000_000);
        expect(c.selectedScenarioPaths.length).toBeLessThanOrEqual(1);
        expect(c.durationMs).toBeLessThanOrEqual(25_000);
        for (const key of ["stdoutPath", ...(c.resultPath ? ["resultPath"] : [])]) {
          const path = join(roots[index], c[key]);
          expect((await stat(path)).mode & 0o077).toBe(0);
        }
        const stdout = JSON.parse(await readFile(join(roots[index], c.stdoutPath), "utf8"));
        expect(validate(stdout)).toBe(true);
        if (c.resultPath) {
          const full = JSON.parse(await readFile(join(roots[index], c.resultPath), "utf8"));
          expect(validate(full)).toBe(true);
        }
      }
      expect((await stat(roots[index])).mode & 0o077).toBe(0);
      expect(JSON.stringify(m)).not.toMatch(/_SENTINEL|_SECRET/);
    }
    const normalize = (m: BenchmarkManifest) =>
      m.cases.map(
        ({ durationMs, totalRunBytes, resultPath, stdoutPath, media, ...benchmarkCase }) => ({
          ...benchmarkCase,
          media: { pngCount: media.pngCount, webmCount: media.webmCount },
        }),
      );
    const first = manifests[0];
    const second = manifests[1];
    if (!first || !second) throw new Error("benchmark manifests were not produced");
    expect(normalize(first)).toEqual(normalize(second));
    const byId = Object.fromEntries(
      first.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]),
    ) as Record<string, BenchmarkCase>;
    expect(byId["static-document"]).toMatchObject({
      exitCode: 0,
      applicability: "not-applicable",
      appliedReceipts: [],
    });
    expect(byId["ssr-document"]).toMatchObject({
      exitCode: 0,
      applicability: "not-applicable",
      appliedReceipts: [],
    });
    expect(byId["public-spa-retry"].appliedReceipts).toHaveLength(2);
    expect(byId["public-spa-retry"].observationKinds).toEqual(
      expect.arrayContaining([
        "content.spinner-persisted",
        "content.error-text-appeared",
        "content.controls-added",
      ]),
    );
    expect(byId["blank-panel"].observationKinds).toEqual(
      expect.arrayContaining(["content.blank-panel-appeared", "content.region-changed"]),
    );
    expect(byId["authenticated-spa"].appliedReceipts).toEqual([
      { path: "/api/auth-business", method: "GET" },
    ]);
    expect(byId["oauth-expired"]).toMatchObject({ exitCode: 1, resultPath: null });
    expect(byId["same-site-api"].appliedReceipts).toEqual([{ path: "/api/cors", method: "GET" }]);
    for (const id of ["safety-business", "safety-forbidden-only"]) {
      const a = byId[id].serverActivity;
      for (const k of [
        "thirdParty",
        "telemetry",
        "mutationAttempts",
        "mutationDryRuns",
        "speculative",
        "embeddedDocument",
      ])
        expect(a[k]).toBeGreaterThan(0);
      expect(byId[id].mutationStateWrites).toBe(0);
    }
    expect(byId["safety-business"].selectedScenarioPaths).toEqual(["/api/business"]);
    expect(byId["safety-business"].matchedReceiptRecords).toEqual([
      { path: "/api/business", method: "GET" },
    ]);
    expect(byId["safety-business"].appliedReceipts).toEqual([
      { path: "/api/business", method: "GET" },
    ]);
    expect(byId["safety-forbidden-only"]).toMatchObject({
      applicability: "not-applicable",
      selectedScenarioPaths: [],
      matchedReceiptRecords: [],
      appliedReceipts: [],
    });
  }, 240_000);
  afterAll(async () => {
    for (const r of roots) await rm(r, { recursive: true, force: true });
  });
});
