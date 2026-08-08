#!/usr/bin/env node
/**
 * `tremor` — the engine as a command line tool.
 *
 * Contract: stdout is exactly one JSON document, stderr carries logs. Exit code
 * reflects whether the *run* succeeded, never what it found — the engine emits
 * observations, not verdicts, so "12 observations" is not a failure. A judge
 * decides that, and under the default it is the agent that invoked this.
 */

import { parseArgs } from "node:util";
import { chromium } from "playwright";
import {
  listProfiles,
  loadProfile,
  removeProfile,
  saveProfile,
  untilUrlMatches,
  validateAuthSelection,
} from "../auth/profiles";
import type { CpuProfile } from "../capture/cpu-profiles";
import { CPU_PROFILES } from "../capture/cpu-profiles";
import { PRESETS } from "../chaos/presets";
import type { WaitUntil } from "../driver/driver";
import {
  type ChaosOutput,
  type CommonOptions,
  commandChaos,
  commandObserve,
  commandScan,
  type ObserveOutput,
  type ScanOutput,
  type ScenarioCategory,
} from "./commands";
import { compactObservation, digestChaos, digestScan } from "./digest";
import { createRunDir, emit, fail } from "./run-dir";

const COMMANDS = ["scan", "observe", "chaos"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `tremor — browser observation engine

Usage
  tremor <command> <url> [options]

Commands
  scan      Capture traffic, dedupe endpoints, generate fault scenarios. Applies no faults.
  observe   Load the page and emit observations.
  chaos     Observe a clean baseline, inject faults, reload, observe again.

Options
  --out <dir>          Run-directory root (default: tremor-runs)
  --filter <text>      Only endpoints whose path contains this
  --preset <id>        Chaos preset; repeatable. Omit to derive faults from captured traffic
  --scenarios <n>      How many scenarios to probe (default: 5)
  --concurrency <n>    Scenarios probed at once (default: 4)
  --category <name>    Scenario category for derived faults; repeatable.
                       error | timing | empty | corruption  (default: error)
  --wait <state>       load | domcontentloaded | networkidle | commit  (default: load)
  --timeout <ms>       Navigation timeout (default: 30000)
  --viewport <WxH>     Viewport size (default: 1280x720)
  --cpu <profile>      ${Object.keys(CPU_PROFILES).join(" | ")}
  --auth-state <file>  Playwright storageState JSON to restore a session
  --profile <name>      Named secure auth profile
  --seed <value>       Deterministic scenario IDs and effect decisions
  --headed             Show the browser
  --no-video           Skip video recording
  --full               Print the unabridged payload instead of the digest
  --help

Presets
  ${PRESETS.map((p) => p.id).join(", ")}

Output
  stdout  one JSON document (also written to <run-dir>/result.json)
  stderr  structured logs
  exit    0 run completed · 1 run failed · 2 bad usage
`;

const CATEGORIES: ScenarioCategory[] = ["error", "timing", "empty", "corruption"];
const WAIT_STATES: WaitUntil[] = ["load", "domcontentloaded", "networkidle", "commit"];

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stderr.write(USAGE);
    process.exit(argv.length === 0 ? 2 : 0);
  }

  const command = argv[0] as Command;
  if (argv[0] === "auth") {
    await authCommand(argv.slice(1));
    return;
  }
  if (!COMMANDS.includes(command)) {
    process.stderr.write(USAGE);
    fail(`Unknown command "${command}"`, 2);
  }

  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        out: { type: "string", default: "tremor-runs" },
        filter: { type: "string" },
        preset: { type: "string", multiple: true, default: [] },
        wait: { type: "string", default: "load" },
        timeout: { type: "string", default: "30000" },
        viewport: { type: "string", default: "1280x720" },
        cpu: { type: "string" },
        category: { type: "string", multiple: true, default: [] },
        scenarios: { type: "string", default: "5" },
        concurrency: { type: "string", default: "4" },
        "auth-state": { type: "string" },
        profile: { type: "string" },
        seed: { type: "string", default: "tremor-default-seed" },
        headed: { type: "boolean", default: false },
        "no-video": { type: "boolean", default: false },
        full: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 2);
  }

  if (parsed.values.help) {
    process.stderr.write(USAGE);
    process.exit(0);
  }

  try {
    validateAuthSelection(
      parsed.values.profile as string | undefined,
      parsed.values["auth-state"] as string | undefined,
    );
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 2);
  }
  const url = parsed.positionals[0];
  if (!url) fail(`Missing <url>. Try: tremor ${command} https://example.com`, 2);
  try {
    new URL(url);
  } catch {
    fail(`"${url}" is not a valid URL`, 2);
  }
  let profileState: string | undefined;
  if (parsed.values.profile) {
    try {
      profileState = (await loadProfile(String(parsed.values.profile), url)).storageStatePath;
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), 2);
    }
  }

  const wait = String(parsed.values.wait);
  if (!WAIT_STATES.includes(wait as WaitUntil)) {
    fail(`--wait must be one of ${WAIT_STATES.join(", ")}`, 2);
  }

  const cpu = parsed.values.cpu as CpuProfile | undefined;
  if (cpu && !(cpu in CPU_PROFILES)) {
    fail(`--cpu must be one of ${Object.keys(CPU_PROFILES).join(", ")}`, 2);
  }

  // Validated before a browser launches: finding out a preset name is wrong
  // after 30s of page load is a bad trade.
  const presetIds = (parsed.values.preset as string[]) ?? [];
  for (const id of presetIds) {
    if (!PRESETS.some((p) => p.id === id)) {
      fail(`Unknown preset "${id}". Available: ${PRESETS.map((p) => p.id).join(", ")}`, 2);
    }
  }
  if (presetIds.length > 0 && command !== "chaos") {
    fail(`--preset only applies to "chaos", not "${command}"`, 2);
  }

  const categories = ((parsed.values.category as string[]) ?? []) as ScenarioCategory[];
  for (const c of categories) {
    if (!CATEGORIES.includes(c)) fail(`--category must be one of ${CATEGORIES.join(", ")}`, 2);
  }
  if (categories.length > 0 && command !== "chaos") {
    fail(`--category only applies to "chaos", not "${command}"`, 2);
  }

  const scenarioCount = Number(parsed.values.scenarios);
  if (!Number.isInteger(scenarioCount) || scenarioCount < 1) {
    fail("--scenarios must be a positive integer", 2);
  }
  const concurrency = Number(parsed.values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    fail("--concurrency must be a positive integer", 2);
  }

  const viewport = parseViewport(String(parsed.values.viewport));
  if (!viewport) fail("--viewport must look like 1280x720", 2);

  const timeoutMs = Number(parsed.values.timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout must be a positive number", 2);

  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const runDir = createRunDir(String(parsed.values.out), command, stamp);

  const opts: CommonOptions = {
    url,
    runDir,
    headless: !parsed.values.headed,
    waitUntil: wait as WaitUntil,
    timeoutMs,
    viewport,
    video: !parsed.values["no-video"],
    cpu,
    authState: profileState ?? (parsed.values["auth-state"] as string | undefined),
    seed: String(parsed.values.seed),
  };

  const filter = parsed.values.filter as string | undefined;

  const result =
    command === "scan"
      ? await commandScan(opts, filter)
      : command === "observe"
        ? await commandObserve(opts)
        : await commandChaos(
            opts,
            presetIds,
            filter,
            categories.length > 0 ? categories : undefined,
            scenarioCount,
            concurrency,
          );

  if (!result.ok) fail(result.error.message, 1);

  const value = result.value;
  const digest =
    command === "scan"
      ? digestScan(
          (value as unknown as ScanOutput).endpoints,
          (value as unknown as ScanOutput).scenarios,
          (value as unknown as ScanOutput).exchangeCount,
        )
      : command === "chaos"
        ? digestChaos(value as unknown as ChaosOutput)
        : {
            observations: (value as unknown as ObserveOutput).observations.map(compactObservation),
            videoPath: (value as unknown as { videoPath: string | null }).videoPath,
          };

  emit(
    {
      schemaVersion: 1,
      command,
      url,
      startedAt,
      durationMs: Date.now() - startedAt,
      runDir,
      result: value,
    },
    digest,
    Boolean(parsed.values.full),
  );
}

async function authCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "list") {
    process.stdout.write(JSON.stringify(await listProfiles()) + "\\n");
    return;
  }
  if (sub === "remove") {
    const name = argv[1];
    if (!name) fail("Usage: tremor auth remove <name>", 2);
    try {
      await removeProfile(name);
      process.stdout.write(JSON.stringify({ removed: name }) + "\\n");
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), 2);
    }
    return;
  }
  if (sub !== "setup")
    fail("Usage: tremor auth setup <url> --profile <name> [--until-url <url-or-prefix>]", 2);
  let p: ReturnType<typeof parseArgs>;
  try {
    p = parseArgs({
      args: argv.slice(1),
      allowPositionals: true,
      options: {
        profile: { type: "string" },
        "until-url": { type: "string" },
        "auth-timeout": { type: "string", default: "300000" },
      },
    });
  } catch (e) {
    fail(String(e), 2);
  }
  const url = p!.positionals[0],
    name = p!.values.profile as string | undefined,
    until = p!.values["until-url"] as string | undefined;
  if (!url || !name)
    fail("Usage: tremor auth setup <url> --profile <name> [--until-url <url-or-prefix>]", 2);
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    fail("Invalid URL", 2);
  }
  if (until) {
    try {
      new URL(until.endsWith("*") ? until.slice(0, -1) : until);
    } catch {
      fail("Invalid --until-url", 2);
    }
  }
  const timeout = Number(p!.values["auth-timeout"]);
  if (!Number.isFinite(timeout) || timeout <= 0) fail("--auth-timeout must be positive", 2);
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(target.href);
    if (until) {
      const deadline = Date.now() + timeout;
      while (!untilUrlMatches(page.url(), until)) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for --until-url");
        await new Promise((r) => setTimeout(r, 250));
      }
    } else {
      process.stderr.write("Complete authentication in the browser, then press Enter.\\n");
      await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
    }
    const metadata = await saveProfile(name, target.href, await context.storageState());
    process.stdout.write(JSON.stringify(metadata) + "\\n");
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

function parseViewport(value: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

main()
  // Playwright can leave handles that keep the loop alive after every browser
  // is closed. Everything is already flushed to disk and stdout by this point,
  // so exit rather than hang.
  .then(() => finish(0))
  .catch((e) => fail(e instanceof Error ? e.message : String(e), 1));

function finish(code: number): void {
  if (process.stdout.write("")) process.exit(code);
  else process.stdout.once("drain", () => process.exit(code));
}
