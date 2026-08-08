import { existsSync, lstatSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createRunDir, emit, stripAnsi } from "../src/cli/run-dir";

const ROOT = join(process.cwd(), ".test-runs");
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

const ESC = String.fromCharCode(27);

describe("stripAnsi", () => {
  it("removes the colour codes Playwright embeds in call logs", () => {
    expect(stripAnsi(`${ESC}[2m  - navigating${ESC}[22m`)).toBe("  - navigating");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("net::ERR_FAILED")).toBe("net::ERR_FAILED");
  });

  it("keeps the message parseable as JSON once stripped", () => {
    const raw = `net::ERR_FAILED\nCall log:\n${ESC}[2m  - navigating${ESC}[22m`;
    const round = JSON.parse(JSON.stringify({ error: stripAnsi(raw) }));
    expect(round.error).not.toContain(ESC);
  });
});

describe("createRunDir", () => {
  it("creates a command-stamped directory under the root", () => {
    const dir = createRunDir(ROOT, "scan", "2020-01-01T00-00-00-000Z");
    expect(existsSync(dir)).toBe(true);
    expect(dir.endsWith("2020-01-01T00-00-00-000Z-scan")).toBe(true);
  });

  it("creates private run directories", () => {
    const dir = createRunDir(ROOT, "scan", "2020-01-01T00-00-00-010Z");
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it("resolves relative roots against cwd, not the module", () => {
    const dir = createRunDir(".test-runs", "observe", "2020-01-01T00-00-00-001Z");
    expect(dir.startsWith(process.cwd())).toBe(true);
  });
});

describe("emit", () => {
  const HEAVY = { hello: "world", body: "x".repeat(5000) };
  const DIGEST = { hello: "world" };

  function capture(stamp: string, full: boolean) {
    const runDir = createRunDir(ROOT, "scan", stamp);
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => {
      written.push(c);
      return true;
    }) as typeof process.stdout.write;

    emit(
      {
        schemaVersion: 1,
        command: "scan",
        url: "https://app.test/",
        startedAt: 1,
        durationMs: 2,
        runDir,
        result: HEAVY,
      },
      DIGEST,
      full,
    );
    process.stdout.write = original;

    return {
      runDir,
      stdout: JSON.parse(written.join("")),
      onDisk: JSON.parse(readFileSync(join(runDir, "result.json"), "utf8")),
    };
  }

  it("always writes the unabridged payload to result.json", () => {
    const { onDisk } = capture("2020-01-01T00-00-00-002Z", false);
    expect(onDisk.result).toEqual(HEAVY);
  });

  it("prints only the digest by default, and points at the full file", () => {
    const { stdout, runDir } = capture("2020-01-01T00-00-00-003Z", false);
    expect(stdout.result).toEqual(DIGEST);
    expect(stdout.full).toBe(join(runDir, "result.json"));
  });

  it("keeps stdout far smaller than the payload it stands in for", () => {
    const { stdout, onDisk } = capture("2020-01-01T00-00-00-004Z", false);
    expect(JSON.stringify(stdout).length).toBeLessThan(JSON.stringify(onDisk).length / 4);
  });

  it("prints the unabridged payload under --full", () => {
    const { stdout } = capture("2020-01-01T00-00-00-005Z", true);
    expect(stdout.result).toEqual(HEAVY);
    expect(stdout.full).toBeUndefined();
  });

  it("writes private result files", () => {
    const { runDir } = capture("2020-01-01T00-00-00-007Z", false);
    expect(lstatSync(join(runDir, "result.json")).mode & 0o777).toBe(0o600);
  });

  it("refuses a pre-created result symlink without touching its target", () => {
    const runDir = createRunDir(ROOT, "scan", "2020-01-01T00-00-00-008Z");
    const victim = join(ROOT, "victim.json");
    writeFileSync(victim, "safe");
    symlinkSync(victim, join(runDir, "result.json"));
    expect(() =>
      emit(
        {
          schemaVersion: 1,
          command: "scan",
          url: "https://app.test/",
          startedAt: 1,
          durationMs: 2,
          runDir,
          result: {},
        },
        {},
        false,
      ),
    ).toThrow(/symlink/);
    expect(readFileSync(victim, "utf8")).toBe("safe");
  });

  it("redacts top-level and nested target URLs before stdout or disk persistence", () => {
    const runDir = createRunDir(ROOT, "scan", "2020-01-01T00-00-00-006Z");
    const written: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string) => {
      written.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      emit(
        {
          schemaVersion: 1,
          command: "scan",
          url: "https://user:sentinel-password@app.test/?accessToken=sentinel-query",
          startedAt: 1,
          durationMs: 2,
          runDir,
          result: {
            targetUrl: "https://app.test/path?sessionId=sentinel-session",
          },
        },
        { targetUrl: "https://app.test/path?clientSecret=sentinel-client" },
        true,
      );
    } finally {
      process.stdout.write = original;
    }

    const persisted = `${written.join("")}\n${readFileSync(join(runDir, "result.json"), "utf8")}`;
    expect(persisted).not.toContain("sentinel-");
  });
});
