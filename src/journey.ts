import { readFileSync } from "node:fs";
import type { AuthGuardResult } from "./auth/guard";
import type { Driver, NavigateOptions } from "./driver/driver";
import { executeStep } from "./journey-execution";
import { err, ok, type Result } from "./types/result";

export type JourneyStep =
  | { id: string; type: "navigate"; path: string }
  | {
      id: string;
      type: "click";
      role?: string;
      name?: string;
      label?: string;
      testId?: string;
      expectPath?: string;
    }
  | { id: string; type: "fill"; label?: string; testId?: string; value: string }
  | {
      id: string;
      type: "wait-visible";
      role?: string;
      name?: string;
      label?: string;
      testId?: string;
    }
  | { id: string; type: "wait"; ms: number }
  | { id: string; type: "checkpoint" };
export type JourneyFile = { version: 1; id: string; steps: JourneyStep[] };
export type JourneyErrorKind =
  | "invalid-journey"
  | "step-failed"
  | "authentication"
  | "unsafe-request-blocked"
  | "target-not-found"
  | "ambiguous-target"
  | "target-not-actionable"
  | "navigation-blocked"
  | "navigation-mismatch";

/** Stable, deliberately sanitized error returned by journey execution. */
export class JourneyError extends Error {
  readonly name = "JourneyError";
  constructor(
    readonly kind: JourneyErrorKind,
    readonly stepId: string | undefined,
    readonly action: string | undefined,
    message = `journey execution failed: ${kind}`,
    readonly receipts: JourneyReceipt[] = [],
    readonly journeyId?: string,
  ) {
    super(message);
  }
}
export type JourneyReceipt = {
  journeyId: string;
  stepId: string;
  type: JourneyStep["type"];
  status: "completed" | "failed";
  checkpointId?: string;
  error?: string;
};

const keys: Record<JourneyStep["type"], string[]> = {
  navigate: ["id", "type", "path"],
  click: ["id", "type", "role", "name", "label", "testId", "expectPath"],
  fill: ["id", "type", "label", "testId", "value"],
  "wait-visible": ["id", "type", "role", "name", "label", "testId"],
  wait: ["id", "type", "ms"],
  checkpoint: ["id", "type"],
};
/** Resolve a declared journey path without allowing URL parser separator/traversal tricks. */
export function resolveSameOriginPath(path: string, targetUrl: string): URL | null {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    [...path].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return character === "\\" || code < 32 || code === 127;
    })
  )
    return null;
  if (
    /%(?:00|1f|2e|5c|7f|2f)/iu.test(path) ||
    path.split(/[/?#]/u).some((part) => part === "." || part === "..")
  )
    return null;
  try {
    const target = new URL(targetUrl);
    const resolved = new URL(path, target);
    return resolved.origin === target.origin ? resolved : null;
  } catch {
    return null;
  }
}

function fail<T = JourneyFile>(message: string): Result<T> {
  return err(
    new JourneyError("invalid-journey", undefined, undefined, `Invalid journey: ${message}`),
  );
}
function validateStepFields(
  type: JourneyStep["type"],
  step: Record<string, unknown>,
): string | undefined {
  if (
    type === "navigate" &&
    (typeof step.path !== "string" || !resolveSameOriginPath(step.path, "https://journey.invalid/"))
  )
    return "navigate path must be same-origin absolute path";
  if (type === "click" && !validTarget(step, "click"))
    return "click needs exactly one target: role+name, label, or testId";
  if (type === "fill" && !validFill(step))
    return "fill needs exactly one target: label or testId and a value";
  if (type === "wait-visible" && !validTarget(step, "wait-visible"))
    return "wait-visible needs exactly one target: role+name, label, or testId";
  if (
    type === "wait" &&
    (!Number.isInteger(step.ms) || (step.ms as number) < 0 || (step.ms as number) > 30000)
  )
    return "wait ms must be 0..30000";
  return undefined;
}
function parseStep(raw: unknown, ids: Set<string>): Result<JourneyStep> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return fail("each step must be an object");
  const step = raw as Record<string, unknown>;
  const type = step.type;
  if (typeof type !== "string" || !(type in keys)) return fail("unknown step type");
  const allowed = keys[type as JourneyStep["type"]];
  if (Object.keys(step).some((key) => !allowed.includes(key)))
    return fail(`unknown key in ${type} step`);
  if (
    typeof step.id !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(step.id) ||
    ids.has(step.id)
  )
    return fail("step ids must be unique safe identifiers");
  const error = validateStepFields(type as JourneyStep["type"], step);
  if (error) return fail(error);
  ids.add(step.id);
  return ok(step as unknown as JourneyStep);
}
function validTarget(s: Record<string, unknown>, type: "click" | "wait-visible"): boolean {
  const role = typeof s.role === "string" && s.role.length > 0;
  const name = typeof s.name === "string" && s.name.length > 0;
  const label = typeof s.label === "string" && s.label.length > 0;
  const testId = typeof s.testId === "string" && s.testId.length > 0;
  if (role !== name || Number(label) + Number(testId) + Number(role && name) !== 1) return false;
  return (
    type !== "click" ||
    s.expectPath === undefined ||
    (typeof s.expectPath === "string" &&
      !!resolveSameOriginPath(s.expectPath, "https://journey.invalid/"))
  );
}
function validFill(s: Record<string, unknown>): boolean {
  const label = typeof s.label === "string" && s.label.length > 0;
  const testId = typeof s.testId === "string" && s.testId.length > 0;
  return typeof s.value === "string" && s.value.length > 0 && Number(label) + Number(testId) === 1;
}
export function parseJourney(input: unknown): Result<JourneyFile> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return fail("expected an object");
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !["version", "id", "steps"].includes(key)))
    return fail("unknown top-level key");
  if (
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.id)
  )
    return fail("version must be 1 and id must be a safe identifier");
  if (!Array.isArray(value.steps) || value.steps.length === 0 || value.steps.length > 100)
    return fail("steps must contain 1 to 100 entries");
  const ids = new Set<string>();
  const steps: JourneyStep[] = [];
  for (const raw of value.steps) {
    const step = parseStep(raw, ids);
    if (!step.ok) return step;
    steps.push(step.value);
  }
  if (steps.at(-1)?.type !== "checkpoint") return fail("the final step must be a checkpoint");
  return ok({ version: 1, id: value.id, steps });
}
export function loadJourney(path: string): Result<JourneyFile> {
  try {
    return parseJourney(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return fail("file is not readable JSON");
  }
}

type JourneyOptions = {
  navigate?: NavigateOptions;
  onCheckpoint?: (id: string, stepId: string) => Promise<void>;
  beforeStep?: (step: JourneyStep) => Promise<void>;
  afterStep?: (step: JourneyStep, receipt: JourneyReceipt) => Promise<void>;
  afterBootstrap?: () => Promise<void>;
  authGuard?: () => AuthGuardResult;
  stopAtCheckpoint?: string;
};
type JourneyGuard = Extract<Awaited<ReturnType<Driver["installJourneySafetyGuard"]>>, { ok: true }>;

async function bootstrapJourney(
  driver: Driver,
  target: URL,
  journey: JourneyFile,
  options: JourneyOptions,
  receipts: JourneyReceipt[],
): Promise<Result<JourneyGuard>> {
  const bootstrap = await driver.navigate(target.href, options.navigate);
  await driver.waitForIdle();
  const auth = options.authGuard?.();
  if (auth && !auth.ok)
    return err(
      new JourneyError(
        "authentication",
        undefined,
        "authentication",
        auth.message,
        receipts,
        journey.id,
      ),
    );
  if (!bootstrap.ok)
    return err(
      new JourneyError("step-failed", undefined, "bootstrap", undefined, receipts, journey.id),
    );
  if (driver.currentUrl() !== target.href)
    return err(
      new JourneyError(
        "navigation-mismatch",
        undefined,
        "bootstrap",
        undefined,
        receipts,
        journey.id,
      ),
    );
  await options.afterBootstrap?.();
  const guard = await driver.installJourneySafetyGuard();
  if (!guard.ok)
    return err(
      new JourneyError(
        "unsafe-request-blocked",
        undefined,
        undefined,
        undefined,
        receipts,
        journey.id,
      ),
    );
  return ok(guard);
}

async function completeStep(
  driver: Driver,
  journey: JourneyFile,
  step: JourneyStep,
  target: URL,
  options: JourneyOptions,
  guard: JourneyGuard,
  receipts: JourneyReceipt[],
): Promise<boolean> {
  await options.beforeStep?.(step);
  await executeStep(driver, step, target, options, guard);
  await driver.waitForIdle();
  if (guard.value.blocked) throw new JourneyError("unsafe-request-blocked", step.id, step.type);
  const receipt: JourneyReceipt = {
    journeyId: journey.id,
    stepId: step.id,
    type: step.type,
    status: "completed",
    ...(step.type === "checkpoint" ? { checkpointId: step.id } : {}),
  };
  receipts.push(receipt);
  await options.afterStep?.(step, receipt);
  if (step.type !== "checkpoint") return true;
  await options.onCheckpoint?.(step.id, step.id);
  return options.stopAtCheckpoint !== step.id;
}

async function failStep(
  journey: JourneyFile,
  step: JourneyStep,
  cause: unknown,
  guard: JourneyGuard,
  receipts: JourneyReceipt[],
): Promise<Result<void>> {
  const typed = guard.value.blockedNavigation
    ? new JourneyError("navigation-blocked", step.id, step.type)
    : cause instanceof JourneyError
      ? cause
      : new JourneyError("step-failed", step.id, step.type);
  receipts.push({
    journeyId: journey.id,
    stepId: step.id,
    type: step.type,
    status: "failed",
    error: typed.message,
  });
  await guard.value.dispose();
  return err(
    new JourneyError(
      typed.kind,
      typed.stepId ?? step.id,
      typed.action ?? step.type,
      typed.message,
      [...receipts],
      journey.id,
    ),
  );
}

async function runSteps(
  driver: Driver,
  journey: JourneyFile,
  target: URL,
  options: JourneyOptions,
  guard: JourneyGuard,
  receipts: JourneyReceipt[],
): Promise<Result<void>> {
  for (const step of journey.steps) {
    try {
      if (!(await completeStep(driver, journey, step, target, options, guard, receipts))) break;
    } catch (cause) {
      return failStep(journey, step, cause, guard, receipts);
    }
  }
  return ok(undefined);
}

export async function runJourney(
  driver: Driver,
  journey: JourneyFile,
  targetUrl: string,
  options: JourneyOptions = {},
): Promise<Result<JourneyReceipt[]>> {
  const receipts: JourneyReceipt[] = [];
  const target = new URL(targetUrl);
  const boot = await bootstrapJourney(driver, target, journey, options, receipts);
  if (!boot.ok) return boot;
  const guard = boot.value;
  const steps = await runSteps(driver, journey, target, options, guard, receipts);
  if (!steps.ok) return err(steps.error);
  const blocked = guard.value.blocked;
  await guard.value.dispose();
  return blocked
    ? err(
        new JourneyError(
          "unsafe-request-blocked",
          undefined,
          undefined,
          undefined,
          receipts,
          journey.id,
        ),
      )
    : ok(receipts);
}
