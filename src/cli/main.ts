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
import type { AuthSelection } from "../auth/guard";
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
import { JourneyError, type JourneyFile, loadJourney } from "../journey";
import { VERSION } from "../version";
import {
  type ChaosOutput,
  type CommonOptions,
  commandChaos,
  commandObserve,
  commandScan,
  normalizeBudgetArgs,
  type ObserveOutput,
  type RouteChaosOutput,
  type RouteScanOutput,
  type ScanOutput,
  type ScenarioCategory,
} from "./commands";
import {
  compactObservation,
  digestChaos,
  digestRouteChaos,
  digestRouteScan,
  digestScan,
} from "./digest";
import { parseRoutes } from "./routes";
import { createRunDir, emit, fail } from "./run-dir";

const COMMANDS = ["scan", "observe", "chaos"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `tremor v${VERSION} — browser observation engine

Usage
  tremor <url> [options]
  tremor <command> <url> [options]

Commands
  scan      Capture traffic, dedupe endpoints, generate fault scenarios. Applies no faults.
  observe   Load the page and emit observations.
  chaos     Observe a clean baseline, inject faults, reload, observe again.

Options
  --out <dir>          Run-directory root (default: tremor-runs)
  --routes <paths>     Complete comma-separated route list (scan/chaos, max 10)
  --filter <text>      Only endpoints whose path contains this
  --preset <id>        Chaos preset; repeatable. Omit to derive faults from captured traffic
  --fault latency      Select deterministic 1000ms latency (default: deterministic 503)
  --budget <n>        Smoke scenarios to probe (default: 3)
  --proof-limit <n>   Maximum proof reruns (default: 2)
  --scenarios <n>      Compatibility alias for --budget
  --concurrency <n>    Scenarios probed at once (default: 4)
  --category <name>    Scenario category for derived faults; repeatable.
                       error | timing | empty | corruption  (default: error)
  --wait <state>       load | domcontentloaded | networkidle | commit  (default: load)
  --timeout <ms>       Navigation timeout (default: 30000)
  --viewport <WxH>     Viewport size (default: 1280x720)
  --cpu <profile>      ${Object.keys(CPU_PROFILES).join(" | ")}
  --auth-state <file>  Playwright storageState JSON to restore a session
  --profile <name>      Named secure auth profile
  --journey <file>      Versioned JSON interaction journey (scan/chaos)
  --seed <value>       Deterministic scenario IDs and effect decisions
  --headed             Show the browser
  --no-video           Skip video recording
  --full               Print the unabridged payload instead of the digest
  --version
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
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (argv.length === 0 || argv[0] === "--help" || argv[0] === "-h") {
    process.stderr.write(USAGE);
    process.exit(argv.length === 0 ? 2 : 0);
  }
  if (argv[0] === "auth") {
    await authCommand(argv.slice(1));
    return;
  }
  await executeCommand(argv);
}

type ParsedCommandArgs = ReturnType<typeof parseArgs>;

interface ParsedInvocation {
  argv: string[];
  command: Command;
  parsed: ParsedCommandArgs;
}

interface ExecutionContext extends ParsedInvocation {
  url: string;
  routes?: ReturnType<typeof parseRoutes>;
  profileState?: string;
  authSelection: AuthSelection;
  wait: WaitUntil;
  cpu?: CpuProfile;
  journey?: JourneyFile;
  presetIds: string[];
  fault?: string;
  categories: ScenarioCategory[];
  scenarioCount: number;
  proofLimit: number;
  concurrency: number;
  viewport: { width: number; height: number };
  timeoutMs: number;
}

async function executeCommand(argv: string[]): Promise<void> {
  if (argv[0] === "auth") {
    await authCommand(argv.slice(1));
    return;
  }
  const invocation = parseInvocation(resolveInvocation(argv));
  const withUrl = validateAuthAndUrl(invocation);
  const withRoutes = parseRouteRestrictions(withUrl);
  const withAuth = await loadProfileSelection(withRoutes);
  const withRuntime = validateWaitAndCpu(withAuth);
  const withScenario = loadJourneyAndValidateScenario(withRuntime);
  const context = normalizeExecution(withScenario);
  await completeCommand(constructCompleteContext(context));
}

function resolveInvocation(argv: string[]): Omit<ParsedInvocation, "parsed"> {
  const shorthand = !COMMANDS.includes(argv[0] as Command);
  const command = (shorthand ? "chaos" : argv[0]) as Command;
  if (!COMMANDS.includes(command)) {
    process.stderr.write(USAGE);
    fail(`Unknown command "${command}"`, 2);
  }
  return { argv, command };
}

function parseInvocation(invocation: Omit<ParsedInvocation, "parsed">): ParsedInvocation {
  const shorthand = invocation.argv[0] !== invocation.command;
  const parsed = parseCommandArgs(invocation.argv, shorthand);
  if (parsed.values.help) {
    process.stderr.write(USAGE);
    process.exit(0);
  }
  return { ...invocation, parsed };
}

function validateAuthAndUrl(invocation: ParsedInvocation): ParsedInvocation & { url: string } {
  const { parsed, command } = invocation;
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
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") throw new Error();
  } catch {
    fail(`"${url}" is not a valid http(s) URL`, 2);
  }
  return { ...invocation, url };
}

function parseRouteRestrictions<T extends ParsedInvocation & { url: string }>(
  context: T,
): T & { routes?: ReturnType<typeof parseRoutes> } {
  const { parsed, command, url } = context;
  if (parsed.values.routes === undefined) return context;
  if (command === "observe") fail("--routes is not supported by observe", 2);
  if (parsed.values.journey) fail("--routes cannot be combined with --journey", 2);
  if ((parsed.values.preset as string[]).length > 0)
    fail("--routes cannot be combined with --preset", 2);
  try {
    return { ...context, routes: parseRoutes(String(parsed.values.routes), url) };
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 2);
  }
}

async function loadProfileSelection<T extends ParsedInvocation & { url: string }>(
  context: T,
): Promise<T & { profileState?: string; authSelection: AuthSelection }> {
  const profileName = context.parsed.values.profile;
  if (!profileName) {
    const authSelection: AuthSelection = context.parsed.values["auth-state"]
      ? { kind: "state" }
      : { kind: "none" };
    return { ...context, authSelection };
  }
  try {
    const profile = await loadProfile(String(profileName), context.url);
    return {
      ...context,
      profileState: profile.storageStatePath,
      authSelection: { kind: "profile", name: String(profileName) },
    };
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 2);
  }
}

function validateWaitAndCpu<T extends ParsedInvocation>(
  context: T,
): T & { wait: WaitUntil; cpu?: CpuProfile } {
  const wait = String(context.parsed.values.wait);
  if (!WAIT_STATES.includes(wait as WaitUntil))
    fail(`--wait must be one of ${WAIT_STATES.join(", ")}`, 2);
  const cpu = context.parsed.values.cpu as CpuProfile | undefined;
  if (cpu && !(cpu in CPU_PROFILES))
    fail(`--cpu must be one of ${Object.keys(CPU_PROFILES).join(", ")}`, 2);
  return { ...context, wait: wait as WaitUntil, cpu };
}

function loadJourneyAndValidateScenario<T extends ParsedInvocation>(
  context: T,
): T & {
  journey?: JourneyFile;
  presetIds: string[];
  fault?: string;
  categories: ScenarioCategory[];
} {
  const journey = loadAndValidateJourney(context);
  const presetIds = validatePresets(context, journey);
  const fault = validateFault(context, presetIds);
  const categories = validateCategories(context, fault);
  return { ...context, journey, presetIds, fault, categories };
}

function loadAndValidateJourney(context: ParsedInvocation): JourneyFile | undefined {
  const journeyPath = context.parsed.values.journey as string | undefined;
  if (!journeyPath) return undefined;
  if (context.command === "observe") fail("--journey is not supported by observe", 2);
  const loaded = loadJourney(journeyPath);
  if (!loaded.ok) fail(loaded.error.message, 2);
  return loaded.value;
}

function validatePresets(context: ParsedInvocation, journey?: JourneyFile): string[] {
  const presetIds = (context.parsed.values.preset as string[]) ?? [];
  for (const id of presetIds) {
    if (!PRESETS.some((preset) => preset.id === id))
      fail(`Unknown preset "${id}". Available: ${PRESETS.map((p) => p.id).join(", ")}`, 2);
  }
  if (presetIds.length > 0 && context.command !== "chaos")
    fail(`--preset only applies to "chaos", not "${context.command}"`, 2);
  if (presetIds.length > 0 && journey) fail("--journey cannot be combined with --preset", 2);
  return presetIds;
}

function validateFault(context: ParsedInvocation, presetIds: string[]): string | undefined {
  const fault = context.parsed.values.fault as string | undefined;
  if (fault && fault !== "latency") fail('--fault currently supports only "latency"', 2);
  if (fault && context.command !== "chaos")
    fail(`--fault only applies to "chaos", not "${context.command}"`, 2);
  if (fault && presetIds.length > 0) fail("--fault cannot be combined with --preset", 2);
  return fault;
}

function validateCategories(context: ParsedInvocation, fault?: string): ScenarioCategory[] {
  const categories = ((context.parsed.values.category as string[]) ?? []) as ScenarioCategory[];
  for (const category of categories) {
    if (!CATEGORIES.includes(category))
      fail(`--category must be one of ${CATEGORIES.join(", ")}`, 2);
  }
  if (categories.length > 0 && context.command !== "chaos")
    fail(`--category only applies to "chaos", not "${context.command}"`, 2);
  if (fault && categories.length > 0) fail("--fault cannot be combined with --category", 2);
  return categories;
}

function normalizeExecution<T extends ParsedInvocation>(
  context: T,
): T &
  Pick<
    ExecutionContext,
    "scenarioCount" | "proofLimit" | "concurrency" | "viewport" | "timeoutMs"
  > {
  const budgetOptions = normalizeBudgets(context);
  const concurrency = Number(context.parsed.values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    fail("--concurrency must be a positive integer", 2);
  const viewport = parseViewport(String(context.parsed.values.viewport));
  if (!viewport) fail("--viewport must look like 1280x720", 2);
  const timeoutMs = Number(context.parsed.values.timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout must be a positive number", 2);
  return {
    ...context,
    scenarioCount: budgetOptions.count,
    proofLimit: budgetOptions.proofLimit,
    concurrency,
    viewport,
    timeoutMs,
  };
}

function normalizeBudgets(context: ParsedInvocation) {
  try {
    return normalizeBudgetArgs(
      {
        budget: context.parsed.values.budget as string | undefined,
        scenarios: context.parsed.values.scenarios as string | undefined,
        proofLimit: context.parsed.values["proof-limit"] as string | undefined,
      },
      {
        budget: context.argv.some((arg) => arg === "--budget" || arg.startsWith("--budget=")),
        scenarios: context.argv.some(
          (arg) => arg === "--scenarios" || arg.startsWith("--scenarios="),
        ),
      },
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 2);
  }
}

function constructCompleteContext(context: ExecutionContext): CompleteContext {
  const startedAt = Date.now();
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
  const runDir = createRunDir(String(context.parsed.values.out), context.command, stamp);
  const opts: CommonOptions = {
    url: context.url,
    runDir,
    headless: !context.parsed.values.headed,
    waitUntil: context.wait,
    timeoutMs: context.timeoutMs,
    viewport: context.viewport,
    video: !context.parsed.values["no-video"],
    cpu: context.cpu,
    authState: context.profileState ?? (context.parsed.values["auth-state"] as string | undefined),
    authSelection: context.authSelection,
    seed: String(context.parsed.values.seed),
    journey: context.journey,
    routes: context.routes,
  };
  return {
    command: context.command,
    opts,
    filter: context.parsed.values.filter as string | undefined,
    presetIds: context.presetIds,
    categories: context.categories,
    scenarioCount: context.scenarioCount,
    concurrency: context.concurrency,
    proofLimit: context.proofLimit,
    fault: context.fault,
    journey: context.journey,
    full: Boolean(context.parsed.values.full),
    url: context.url,
    startedAt,
    runDir,
  };
}

interface CompleteContext {
  command: Command;
  opts: CommonOptions;
  filter?: string;
  presetIds: string[];
  categories: ScenarioCategory[];
  scenarioCount: number;
  concurrency: number;
  proofLimit: number;
  fault?: string;
  journey?: JourneyFile;
  full: boolean;
  url: string;
  startedAt: number;
  runDir: string;
}

async function completeCommand(context: CompleteContext): Promise<void> {
  const result = await dispatchCommand(context);
  if (!result.ok) reportCommandFailure(result.error, context.journey);
  emitCommandResult(result.value, context);
}

async function dispatchCommand(context: CompleteContext) {
  const { command, opts, filter } = context;
  if (command === "scan") return commandScan(opts, filter);
  if (command === "observe") return commandObserve(opts);
  return commandChaos(
    opts,
    context.presetIds,
    filter,
    context.categories.length ? context.categories : undefined,
    context.scenarioCount,
    context.concurrency,
    context.proofLimit,
    context.fault as "latency" | undefined,
  );
}

function reportCommandFailure(error: JourneyError | Error, journey?: JourneyFile): never {
  fail(
    error.message,
    1,
    error instanceof JourneyError
      ? {
          kind: error.kind,
          journeyId: error.journeyId,
          stepId: error.stepId,
          action: error.action,
          receipts: error.receipts,
        }
      : undefined,
    journey?.steps.flatMap((step) =>
      Object.values(step).filter((value): value is string => typeof value === "string"),
    ) ?? [],
  );
}

function emitCommandResult(
  value: ChaosOutput | ObserveOutput | ScanOutput | RouteChaosOutput | RouteScanOutput,
  context: CompleteContext,
): void {
  const digest = createDigest(context.command, value);
  const values =
    context.journey?.steps.flatMap((step) => (step.type === "fill" ? [step.value] : [])) ?? [];
  emit(
    {
      schemaVersion: 1,
      command: context.command,
      url: context.url,
      startedAt: context.startedAt,
      durationMs: Date.now() - context.startedAt,
      runDir: context.runDir,
      result: value,
    },
    digest,
    context.full,
    values,
  );
}

function createDigest(
  command: Command,
  value: ChaosOutput | ObserveOutput | ScanOutput | RouteChaosOutput | RouteScanOutput,
) {
  if (command === "scan")
    return (value as RouteScanOutput).mode === "routes"
      ? digestRouteScan(value as RouteScanOutput)
      : digestScan(
          (value as ScanOutput).endpoints,
          (value as ScanOutput).scenarios,
          (value as ScanOutput).exchangeCount,
        );
  if (command === "chaos")
    return (value as RouteChaosOutput).mode === "routes"
      ? digestRouteChaos(value as RouteChaosOutput)
      : digestChaos(value as ChaosOutput);
  return {
    observations: (value as ObserveOutput).observations.map(compactObservation),
    videoPath: (value as ObserveOutput & { videoPath: string | null }).videoPath,
  };
}

function parseCommandArgs(argv: string[], shorthand: boolean): ReturnType<typeof parseArgs> {
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: shorthand ? argv : argv.slice(1),
      allowPositionals: true,
      options: {
        out: { type: "string", default: "tremor-runs" },
        filter: { type: "string" },
        routes: { type: "string" },
        preset: { type: "string", multiple: true, default: [] },
        fault: { type: "string" },
        wait: { type: "string", default: "load" },
        timeout: { type: "string", default: "30000" },
        viewport: { type: "string", default: "1280x720" },
        cpu: { type: "string" },
        category: { type: "string", multiple: true, default: [] },
        scenarios: { type: "string" },
        budget: { type: "string", default: "3" },
        "proof-limit": { type: "string", default: "2" },
        concurrency: { type: "string", default: "4" },
        "auth-state": { type: "string" },
        profile: { type: "string" },
        journey: { type: "string" },
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

  return parsed;
}

async function authCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "list") return authList();
  if (sub === "remove") return authRemove(argv[1]);
  if (sub !== "setup")
    fail("Usage: tremor auth setup <url> --profile <name> [--until-url <url-or-prefix>]", 2);
  await authSetup(argv);
}

async function authList(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await listProfiles())}\n`);
}

async function authRemove(name: string | undefined): Promise<void> {
  if (!name) fail("Usage: tremor auth remove <name>", 2);
  try {
    await removeProfile(name);
    process.stdout.write(`${JSON.stringify({ removed: name })}\n`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 2);
  }
}

async function authSetup(argv: string[]): Promise<void> {
  const p = (() => {
    try {
      return parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          profile: { type: "string" },
          "until-url": { type: "string" },
          "auth-timeout": { type: "string", default: "300000" },
        },
      });
    } catch (e) {
      return fail(String(e), 2);
    }
  })();
  const url = p.positionals[0],
    name = p.values.profile as string | undefined,
    until = p.values["until-url"] as string | undefined;
  if (!url || !name)
    fail("Usage: tremor auth setup <url> --profile <name> [--until-url <url-or-prefix>]", 2);
  const target = authTarget(url);
  validateUntil(until);
  const timeout = Number(p.values["auth-timeout"]);
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
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

function authTarget(url: string | undefined): URL {
  if (!url)
    fail("Usage: tremor auth setup <url> --profile <name> [--until-url <url-or-prefix>]", 2);
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error();
    return target;
  } catch {
    fail("Invalid http(s) URL", 2);
  }
}

function validateUntil(until: string | undefined): void {
  if (!until) return;
  try {
    const target = new URL(until.endsWith("*") ? until.slice(0, -1) : until);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error();
  } catch {
    fail("Invalid --until-url", 2);
  }
}

function parseViewport(value: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

process.stdout.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main()
  // Playwright can leave handles that keep the loop alive after every browser
  // is closed. Everything is already flushed to disk and stdout by this point,
  // so exit rather than hang.
  .then(() => finish(0))
  .catch((e) => fail(e instanceof Error ? e.message : String(e), 1));

function finish(code: number): void {
  if (process.stdout.writableNeedDrain) process.stdout.once("drain", () => process.exit(code));
  else process.exit(code);
}
