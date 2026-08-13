#!/usr/bin/env node
/**
 * `tremor` — the engine as a command line tool.
 *
 * Contract: stdout is exactly one JSON document, stderr carries logs. Exit code
 * reflects whether the *run* succeeded, never what it found — the engine emits
 * observations, not verdicts, so "12 observations" is not a failure. A judge
 * decides that, and under the default it is the agent that invoked this.
 */

import type { parseArgs } from "node:util";
import type { AuthSelection } from "../auth/guard";
import { loadProfile, validateAuthSelection } from "../auth/profiles";
import type { CpuProfile } from "../capture/cpu-profiles";
import { CPU_PROFILES } from "../capture/cpu-profiles";
import { PRESETS } from "../chaos/presets";
import type { WaitUntil } from "../driver/driver";
import { type JourneyFile, loadJourney } from "../journey";
import { VERSION } from "../version";
import { authCommand } from "./auth-command";
import { normalizeBudgetArgs, type ScenarioCategory } from "./commands";
import { normalizeDiscoverLimit } from "./discover";
import { parseCommandArgs, parseViewport } from "./options";
import { completeCommand, constructCompleteContext } from "./output";
import { parseRoutes } from "./routes";
import { fail } from "./run-dir";

const COMMANDS = ["scan", "observe", "chaos", "discover"] as const;
type Command = (typeof COMMANDS)[number];

const USAGE = `tremor v${VERSION} — browser observation engine

Usage
  tremor <url> [options]
  tremor <command> <url> [options]

Commands
  scan      Capture traffic, dedupe endpoints, generate fault scenarios. Applies no faults.
  observe   Load the page and emit observations.
  chaos     Observe a clean baseline, inject faults, reload, observe again.
  discover  List candidate same-origin pages from rendered links (does not visit them).

Options
  --out <dir>          Run-directory root (default: tremor-runs)
  --routes <paths>     Complete comma-separated route list (scan/chaos, max 10)
  --limit <n>          Maximum discovered candidates (discover only, default 20, max 100)
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
  discoverLimit: number;
}

async function executeCommand(argv: string[]): Promise<void> {
  if (argv[0] === "auth") {
    await authCommand(argv.slice(1));
    return;
  }
  const invocation = parseInvocation(resolveInvocation(argv));
  const withUrl = validateAuthAndUrl(invocation);
  const withRoutes = parseRouteRestrictions(withUrl);
  if (invocation.command !== "discover" && invocation.parsed.values.limit !== undefined)
    fail("--limit only applies to discover", 2);
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
  if (command === "observe" || command === "discover")
    fail(`--routes is not supported by ${command}`, 2);
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
  if (context.command === "observe" || context.command === "discover")
    fail(`--journey is not supported by ${context.command}`, 2);
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
    "scenarioCount" | "proofLimit" | "concurrency" | "viewport" | "timeoutMs" | "discoverLimit"
  > {
  const budgetOptions = normalizeBudgets(context);
  const concurrency = Number(context.parsed.values.concurrency);
  if (!Number.isInteger(concurrency) || concurrency < 1)
    fail("--concurrency must be a positive integer", 2);
  const viewport = parseViewport(String(context.parsed.values.viewport));
  if (!viewport) fail("--viewport must look like 1280x720", 2);
  const timeoutMs = Number(context.parsed.values.timeout);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail("--timeout must be a positive number", 2);
  let discoverLimit: number;
  try {
    discoverLimit = normalizeDiscoverLimit(
      context.parsed.values.limit === undefined ? undefined : Number(context.parsed.values.limit),
    );
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 2);
  }
  return {
    ...context,
    scenarioCount: budgetOptions.count,
    proofLimit: budgetOptions.proofLimit,
    concurrency,
    viewport,
    timeoutMs,
    discoverLimit,
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
