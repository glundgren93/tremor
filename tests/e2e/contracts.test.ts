import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020";
import { expect, test } from "vitest";

const exec = promisify(execFile);
type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord => {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("expected object");
  return value as JsonRecord;
};
const entries = (value: unknown) => Object.entries(record(value));
const pathWithin = (root: string, path: unknown) => {
  expect(typeof path).toBe("string");
  const value = path as string;
  expect(isAbsolute(value)).toBe(true);
  expect(relative(root, value)).not.toMatch(/^\.\./);
  return value;
};

test("built CLI fixture satisfies every envelope contract", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "tremor-schema-e2e-"));
  await exec("node", ["examples/ci/run-fixture.mjs", root], {
    timeout: 120_000,
    maxBuffer: 20_000_000,
  });
  const manifest = record(JSON.parse(await readFile(resolve(root, "manifest.json"), "utf8")));
  const manifestEntries = record(manifest.entries);
  const schema = JSON.parse(await readFile(resolve("schemas/cli-envelope-v1.schema.json"), "utf8"));
  const validate = new Ajv2020({ strict: true }).compile(schema);
  const values: Record<string, JsonRecord> = {};
  for (const [name, rawEntry] of entries(manifestEntries)) {
    const entry = record(rawEntry);
    const stdoutPath = pathWithin(root, entry.stdout);
    const stdout = record(JSON.parse(await readFile(stdoutPath, "utf8")));
    expect(validate(stdout), `${name} stdout: ${JSON.stringify(validate.errors)}`).toBe(true);
    values[name] = stdout;
    if (entry.result) {
      const resultPath = pathWithin(root, entry.result);
      expect((await stat(resultPath)).mode & 0o777).toBe(0o600);
      const persisted = record(JSON.parse(await readFile(resultPath, "utf8")));
      expect(persisted.full).toBeUndefined();
      expect(validate(persisted), `${name} persisted: ${JSON.stringify(validate.errors)}`).toBe(
        true,
      );
    }
  }
  const staticResult = record(values.staticChaosDigest.result);
  expect(record(staticResult.applicability).status).toBe("not-applicable");
  expect(record(manifestEntries.staticChaosDigest).exitCode).toBe(0);
  const digestResult = record(values.routeChaosDigest.result);
  expect(record(record(digestResult.totals).changed).total).toBeGreaterThan(0);
  const digestChanged = record((digestResult.changed as unknown[])[0]);
  const digestProof = record(digestChanged.proof);
  expect(await stat(pathWithin(root, digestProof.baseline))).toBeTruthy();
  const fullResult = record(values.routeChaosFull.result);
  const fullRoute = record((fullResult.routes as unknown[])[0]);
  const fullOutcome = record((fullRoute.outcomes as unknown[]).find(Boolean));
  const fullProof = record(fullOutcome.proof);
  for (const proofPath of [fullProof.baselineShot, fullProof.faultedShot, fullProof.video].filter(
    Boolean,
  ))
    expect(await stat(pathWithin(root, proofPath))).toBeTruthy();
  expect(record(values.routeScanDigest.result).routes).toHaveLength(2);
  expect(record(manifestEntries.usageError).exitCode).toBe(2);
  expect(values.usageError.error).toBeTruthy();
  const archive = await Promise.all(
    Object.values(manifestEntries)
      .map(record)
      .flatMap((entry) => [entry.stdout, entry.result].filter(Boolean))
      .map((path) => readFile(pathWithin(root, path), "utf8")),
  );
  expect(archive.join("\n")).not.toContain("fixture-secret-token-9f8e7d6c");
  expect(archive.join("\n")).toContain("[REDACTED]");
}, 120_000);
