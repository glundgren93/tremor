import { execFile } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { digestChaos, digestRouteChaos, digestRouteScan, digestScan } from "../src/cli/digest";
import { emit } from "../src/cli/run-dir";

const exec = promisify(execFile);
const schema = JSON.parse(await readFile(resolve("schemas/cli-envelope-v1.schema.json"), "utf8"));
const validate = new Ajv2020({ strict: true }).compile(schema);
const base = (command: "scan" | "observe" | "chaos", result: unknown) => ({
  schemaVersion: 1,
  command,
  url: "https://fixture.test",
  startedAt: 1,
  durationMs: 2,
  runDir: "/tmp/run",
  result,
});
const applicability = { status: "applicable" as const };
const budget = { requested: 1, smoke: 1, proof: 0, seed: "fixture" };
const changed = {
  scenario: { id: "s1", name: "fixture", category: "error", endpoint: "GET /api" },
  appeared: [
    {
      id: "obs-1",
      kind: "content",
      summary: "count changed",
      observedAt: 1,
      target: { selector: null, url: "https://fixture.test" },
      facts: {},
      evidence: [],
    },
  ],
  disappeared: [],
  unchangedCount: 0,
  matchedCount: 1,
  appliedCount: 1,
  receipts: [
    {
      version: 1,
      status: "applied",
      scenarioId: "s1",
      faultId: "f1",
      method: "GET",
      url: "https://fixture.test/api",
      resourceType: "fetch",
      timestamp: 1,
    },
  ],
  attributions: [
    {
      version: 1,
      receipt: { receiptIndex: 0, scenarioId: "s1", faultId: "f1", method: "GET", timestamp: 1 },
      status: "no-region-delta",
      reason: "No changed trusted semantic region was observed.",
      evidence: {
        basis: "isolated-fault-state-comparison",
        appliedReceiptCount: 1,
        changedTrustedRegionCount: 0,
      },
      regionDeltas: [],
    },
  ],
  proof: { baselineShot: null, faultedShot: null, video: null },
  error: null,
};
const notApplicable = {
  status: "not-applicable" as const,
  reason: "no eligible request",
  suggestions: ["declare a journey"],
};

describe("checked CLI schema", () => {
  it("includes versioned contracts in the published package", async () => {
    const packed = await exec("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"]);
    const files = JSON.parse(packed.stdout)[0].files.map((file: { path: string }) => file.path);
    expect(files).toContain("schemas/cli-envelope-v1.schema.json");
    expect(files).toContain("docs/ci-and-agents.md");
    expect(files).toContain("examples/ci/run-fixture.mjs");
  });

  it("validates generated legacy and route digests and full output shapes", () => {
    const scan = { endpoints: [], scenarios: [], exchangeCount: 0, applicability };
    const chaos = {
      outcomes: [changed],
      scanned: { endpoints: 1, scenarios: 1 },
      budget,
      applicability,
    };
    const na = {
      outcomes: [],
      scanned: { endpoints: 0, scenarios: 0 },
      budget: { ...budget, smoke: 0 },
      applicability: notApplicable,
    };
    const routeScan = {
      mode: "routes" as const,
      scanned: { routes: 1, endpoints: 0, scenarios: 0 },
      routes: [
        {
          route: { id: "r01", path: "/", url: "https://fixture.test/" },
          scan,
          aliases: [],
          ownedScenarioIds: [],
        },
      ],
    };
    const routeChaos = {
      mode: "routes" as const,
      scanned: { routes: 1, endpoints: 1, scenarios: 1 },
      budget,
      applicability,
      routes: [
        {
          route: { id: "r01", path: "/", url: "https://fixture.test/" },
          scanned: { endpoints: 1, scenarios: 1 },
          budget: { eligible: 1, owned: 1, deduplicated: 0, smoke: 1, proof: 0 },
          applicability,
          outcomes: [changed],
          aliases: [],
        },
      ],
    };
    const examples = [
      base("scan", scan),
      { ...base("scan", digestScan([], [], 0)), full: "/tmp/run/result.json" },
      base("chaos", chaos),
      { ...base("chaos", digestChaos(chaos)), full: "/tmp/run/result.json" },
      base("chaos", na),
      { ...base("chaos", digestChaos(na)), full: "/tmp/run/result.json" },
      base("scan", routeScan),
      { ...base("scan", digestRouteScan(routeScan)), full: "/tmp/run/result.json" },
      base("chaos", routeChaos),
      { ...base("chaos", digestRouteChaos(routeChaos)), full: "/tmp/run/result.json" },
      { schemaVersion: 1, error: "unknown option" },
    ];
    for (const example of examples)
      expect(validate(example), JSON.stringify(validate.errors)).toBe(true);
  });
  it("rejects missing stable fields, wrong versions, and invalid enums", () => {
    expect(validate({ schemaVersion: 1, command: "scan", result: {} })).toBe(false);
    expect(validate({ schemaVersion: 2, error: "bad" })).toBe(false);
    expect(validate(base("chaos", { applicability: { status: "maybe" } }))).toBe(false);
    expect(validate({ ...base("scan", digestScan([], [], 0)) })).toBe(false);
    expect(
      validate({
        ...base("scan", { endpoints: [], scenarios: [], exchangeCount: 0 }),
        full: "/tmp/result.json",
      }),
    ).toBe(false);
    expect(
      validate({
        ...base("chaos", {
          outcomes: [{}],
          scanned: { endpoints: 0, scenarios: 0 },
          budget,
          applicability,
        }),
      }),
    ).toBe(false);
    expect(validate({ ...base("chaos", { endpoints: [], scenarios: [], exchangeCount: 0 }) })).toBe(
      false,
    );
    expect(
      validate({
        ...base("scan", { endpoints: [], scenarios: [], exchangeCount: 0 }),
        url: "https://",
      }),
    ).toBe(false);
    expect(
      validate({
        ...base("scan", { endpoints: [], scenarios: [], exchangeCount: 0 }),
        url: "https://fixture.test bad",
      }),
    ).toBe(false);
    expect(validate(base("observe", { observations: [], videoPath: null }))).toBe(false);
    expect(validate(base("scan", { endpoints: [{}], scenarios: [], exchangeCount: 0 }))).toBe(
      false,
    );
    expect(validate(base("scan", { endpoints: [], scenarios: [{}], exchangeCount: 0 }))).toBe(
      false,
    );
    expect(
      validate(
        base("observe", {
          sets: [],
          observations: [{ ...changed.appeared[0], evidence: [{}] }],
          videoPath: null,
        }),
      ),
    ).toBe(false);
    expect(
      validate(
        base("chaos", {
          outcomes: [{ ...changed, attributions: [{}] }],
          scanned: { endpoints: 1, scenarios: 1 },
          budget,
          applicability,
        }),
      ),
    ).toBe(false);
    const malformedRoute = {
      mode: "routes",
      scanned: { routes: 1, endpoints: 1, scenarios: 1 },
      budget,
      applicability,
      routes: [
        {
          route: { id: "r", path: "/" },
          scanned: { endpoints: 1, scenarios: 1 },
          budget: { smoke: 1 },
          applicability,
          outcomes: [],
          aliases: [],
        },
      ],
    };
    expect(validate(base("chaos", malformedRoute))).toBe(false);
    const digest = digestChaos({
      outcomes: [changed],
      scanned: { endpoints: 1, scenarios: 1 },
      budget,
      applicability,
    });
    expect(
      validate({ ...base("chaos", { ...digest, changed: [{}] }), full: "/tmp/result.json" }),
    ).toBe(false);
  });
  it("emit creates a bounded digest with an absolute existing 0600 full reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tremor-contract-"));
    const envelope = {
      ...base("scan", { endpoints: [], scenarios: [], exchangeCount: 0 }),
      runDir: dir,
    };
    let output = "";
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      output += chunk;
      return true;
    }) as typeof write;
    try {
      emit(envelope, digestScan([], [], 0), false);
    } finally {
      process.stdout.write = write;
    }
    const digest = JSON.parse(output),
      full = JSON.parse(await readFile(digest.full, "utf8"));
    expect(resolve(digest.full)).toBe(digest.full);
    expect((await stat(digest.full)).mode & 0o777).toBe(0o600);
    expect(full.full).toBeUndefined();
    expect(JSON.stringify(digest)).not.toContain("sampleResponse");
    expect(validate(digest)).toBe(true);
    expect(validate(full)).toBe(true);
  });

  it("redacts secret-named values before traversing their contents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tremor-redaction-"));
    const envelope = {
      ...base("scan", {
        endpoints: [],
        scenarios: [],
        exchangeCount: 0,
        apiKey: { nested: "object-secret" },
        accessToken: ["array-secret"],
        clientSecret: 42,
        authorization: null,
      }),
      runDir: dir,
    };
    let output = "";
    const write = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      output += chunk;
      return true;
    }) as typeof write;
    try {
      emit(envelope, envelope.result, true);
    } finally {
      process.stdout.write = write;
    }
    expect(output).not.toMatch(/object-secret|array-secret|42/);
    expect(JSON.parse(output).result).toMatchObject({
      apiKey: "[REDACTED]",
      accessToken: "[REDACTED]",
      clientSecret: "[REDACTED]",
      authorization: "[REDACTED]",
    });
  });
});

describe("external adapters", () => {
  it("compares legacy and route facts deterministically without copying proof", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tremor-adapter-"));
    const a = join(dir, "a.json"),
      b = join(dir, "b.json");
    await writeFile(
      a,
      JSON.stringify(base("chaos", { outcomes: [], applicability: notApplicable })),
    );
    await writeFile(
      b,
      JSON.stringify(
        base("chaos", {
          mode: "routes",
          routes: [{ route: { id: "r01", path: "/" }, applicability, outcomes: [changed] }],
        }),
      ),
    );
    const one = await exec("node", ["examples/ci/compare-results.mjs", a, b]);
    const two = await exec("node", ["examples/ci/compare-results.mjs", a, b]);
    expect(one.stdout).toBe(two.stdout);
    expect(JSON.parse(one.stdout).delta.changed).toBe(1);
    const reverse = await exec("node", ["examples/ci/compare-results.mjs", b, a]);
    expect(JSON.parse(reverse.stdout).delta.changed).toBe(-1);
    expect(one.stdout).not.toMatch(
      /baselineShot|receipts|observations|sampleResponse|apiKey|accessToken|authorization/i,
    );
  });
  it("rejects invalid adapter usage, digests, versions, commands, and negative policy integers with exit 2", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tremor-invalid-adapter-"));
    const input = join(dir, "input.json"),
      policy = join(dir, "policy.json");
    for (const value of [
      { ...base("chaos", {}), full: "/tmp/result.json" },
      { ...base("scan", {}) },
      { ...base("chaos", {}), schemaVersion: 2 },
    ]) {
      await writeFile(input, JSON.stringify(value));
      await expect(exec("node", ["examples/ci/evaluate-policy.mjs", input])).rejects.toMatchObject({
        code: 2,
      });
    }
    await writeFile(input, JSON.stringify(base("chaos", { outcomes: [], applicability })));
    await writeFile(
      policy,
      JSON.stringify({
        policyVersion: 1,
        allowNotApplicable: true,
        maxOperationalFailures: -1,
        maxChanged: -1,
      }),
    );
    await expect(
      exec("node", ["examples/ci/evaluate-policy.mjs", input, policy]),
    ).rejects.toMatchObject({ code: 2 });
    await expect(exec("node", ["examples/ci/compare-results.mjs", input])).rejects.toMatchObject({
      code: 2,
    });
  });
  it("default policy allows not-applicable and ignores changed; custom policy is explicit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tremor-policy-"));
    const input = join(dir, "result.json"),
      policy = join(dir, "policy.json");
    await writeFile(
      input,
      JSON.stringify(base("chaos", { outcomes: [changed], applicability: notApplicable })),
    );
    const allowed = await exec("node", ["examples/ci/evaluate-policy.mjs", input]);
    expect(JSON.parse(allowed.stdout).decision).toBe("accept");
    expect(allowed.stdout).not.toMatch(
      /baselineShot|receipts|observations|sampleResponse|apiKey|accessToken|authorization/i,
    );
    await writeFile(
      policy,
      JSON.stringify({
        policyVersion: 1,
        allowNotApplicable: false,
        maxOperationalFailures: 0,
        maxChanged: 0,
      }),
    );
    await expect(
      exec("node", ["examples/ci/evaluate-policy.mjs", input, policy]),
    ).rejects.toMatchObject({ code: 1 });
  });
});
