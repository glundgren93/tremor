import { JourneyError, type JourneyFile } from "../journey";
import type {
  ChaosOutput,
  CommonOptions,
  ObserveOutput,
  RouteChaosOutput,
  RouteScanOutput,
  ScanOutput,
  ScenarioCategory,
} from "./commands";
import { commandChaos, commandObserve, commandScan } from "./commands";
import {
  compactObservation,
  digestChaos,
  digestRouteChaos,
  digestRouteScan,
  digestScan,
} from "./digest";
import { createRunDir, emit, fail } from "./run-dir";

type Command = "scan" | "observe" | "chaos";
interface InputContext {
  parsed: ReturnType<typeof import("node:util").parseArgs>;
  command: Command;
  url: string;
  wait: CommonOptions["waitUntil"];
  timeoutMs: number;
  viewport: CommonOptions["viewport"];
  cpu?: CommonOptions["cpu"];
  profileState?: string;
  authSelection: CommonOptions["authSelection"];
  journey?: JourneyFile;
  routes?: CommonOptions["routes"];
  presetIds: string[];
  categories: ScenarioCategory[];
  scenarioCount: number;
  concurrency: number;
  proofLimit: number;
  fault?: string;
}
export function constructCompleteContext(context: InputContext): CompleteContext {
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
export async function completeCommand(context: CompleteContext): Promise<void> {
  const result = await dispatchCommand(context);
  if (!result.ok) reportCommandFailure(result.error, context.journey);
  const value = result.value;
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
