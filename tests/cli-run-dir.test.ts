import { existsSync, readFileSync, rmSync } from "node:fs";
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
});
