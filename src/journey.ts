import { readFileSync } from "node:fs";
import type { AuthGuardResult } from "./auth/guard";
import type { Driver, NavigateOptions } from "./driver/driver";
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

function fail(message: string): Result<JourneyFile> {
  return err(
    new JourneyError("invalid-journey", undefined, undefined, `Invalid journey: ${message}`),
  );
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
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return fail("each step must be an object");
    const s = raw as Record<string, unknown>;
    const type = s.type;
    if (typeof type !== "string" || !(type in keys)) return fail("unknown step type");
    const allowed = keys[type as JourneyStep["type"]];
    if (Object.keys(s).some((k) => !allowed.includes(k)))
      return fail(`unknown key in ${type} step`);
    if (typeof s.id !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(s.id) || ids.has(s.id))
      return fail("step ids must be unique safe identifiers");
    ids.add(s.id);
    if (type === "navigate") {
      if (typeof s.path !== "string" || !resolveSameOriginPath(s.path, "https://journey.invalid/"))
        return fail("navigate path must be same-origin absolute path");
    }
    if (type === "click") {
      const role = typeof s.role === "string" && s.role.length > 0;
      const name = typeof s.name === "string" && s.name.length > 0;
      const label = typeof s.label === "string" && s.label.length > 0;
      const testId = typeof s.testId === "string" && s.testId.length > 0;
      if (role !== name || Number(label) + Number(testId) + Number(role && name) !== 1)
        return fail("click needs exactly one target: role+name, label, or testId");
      if (
        s.expectPath !== undefined &&
        (typeof s.expectPath !== "string" ||
          !resolveSameOriginPath(s.expectPath, "https://journey.invalid/"))
      )
        return fail("click expectPath must be a same-origin absolute path");
    }
    if (type === "fill") {
      const label = typeof s.label === "string" && s.label.length > 0;
      const testId = typeof s.testId === "string" && s.testId.length > 0;
      if (
        typeof s.value !== "string" ||
        s.value.length === 0 ||
        Number(label) + Number(testId) !== 1
      )
        return fail("fill needs exactly one target: label or testId and a value");
    }
    if (type === "wait-visible") {
      const role = typeof s.role === "string" && s.role.length > 0;
      const name = typeof s.name === "string" && s.name.length > 0;
      const label = typeof s.label === "string" && s.label.length > 0;
      const testId = typeof s.testId === "string" && s.testId.length > 0;
      if (role !== name || Number(label) + Number(testId) + Number(role && name) !== 1)
        return fail("wait-visible needs exactly one target: role+name, label, or testId");
    }
    if (
      type === "wait" &&
      (!Number.isInteger(s.ms) || (s.ms as number) < 0 || (s.ms as number) > 30000)
    )
      return fail("wait ms must be 0..30000");
    steps.push(s as unknown as JourneyStep);
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

export async function runJourney(
  driver: Driver,
  journey: JourneyFile,
  targetUrl: string,
  options?: {
    navigate?: NavigateOptions;
    onCheckpoint?: (id: string, stepId: string) => Promise<void>;
    beforeStep?: (step: JourneyStep) => Promise<void>;
    afterStep?: (step: JourneyStep, receipt: JourneyReceipt) => Promise<void>;
    /** Called after bootstrap settles, allowing capture code to discard bootstrap traffic. */
    afterBootstrap?: () => Promise<void>;
    /** Called immediately after bootstrap and every declared navigation settles. */
    authGuard?: () => AuthGuardResult;
    stopAtCheckpoint?: string;
  },
): Promise<Result<JourneyReceipt[]>> {
  const receipts: JourneyReceipt[] = [];
  const target = new URL(targetUrl);
  // Bootstrap uses ordinary page-load semantics so authentication redirects can
  // settle before the action-only safety guard is installed.
  const bootstrap = await driver.navigate(target.href, options?.navigate);
  await driver.waitForIdle();
  const bootstrapAuth = options?.authGuard?.();
  if (bootstrapAuth && !bootstrapAuth.ok)
    return err(
      new JourneyError(
        "authentication",
        undefined,
        "authentication",
        bootstrapAuth.message,
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
  await options?.afterBootstrap?.();
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
  for (const step of journey.steps) {
    try {
      await options?.beforeStep?.(step);
      if (step.type === "navigate") {
        const destination = resolveSameOriginPath(step.path, target.href);
        if (!destination) throw new JourneyError("navigation-blocked", step.id, step.type);
        guard.value.authorizeNavigation?.(destination.href);
        const r = await driver.navigate(destination.href, options?.navigate);
        if (!r.ok || driver.currentUrl() !== destination.href)
          throw new JourneyError("navigation-blocked", step.id, step.type);
        await driver.waitForIdle();
        const auth = options?.authGuard?.();
        if (auth && !auth.ok)
          throw new JourneyError("authentication", step.id, "authentication", auth.message);
      } else if (step.type === "click") {
        const beforeUrl = driver.currentUrl();
        const expectedDestination = step.expectPath
          ? resolveSameOriginPath(step.expectPath, target.href)
          : undefined;
        if (step.expectPath && !expectedDestination)
          throw new JourneyError("navigation-blocked", step.id, step.type);
        if (expectedDestination) guard.value.authorizeNavigation?.(expectedDestination.href);
        const r = await driver.click({
          role: step.role,
          name: step.name,
          label: step.label,
          testId: step.testId,
        });
        if (!r.ok) throw r.error;
        const actual = new URL(driver.currentUrl());
        const expected = expectedDestination?.href;
        if (
          actual.origin !== target.origin ||
          (expected ? actual.href !== expected : actual.href !== beforeUrl)
        )
          throw new JourneyError("navigation-blocked", step.id, step.type);
        if (actual.href !== beforeUrl) {
          const auth = options?.authGuard?.();
          if (auth && !auth.ok)
            throw new JourneyError("authentication", step.id, "authentication", auth.message);
        }
      } else if (step.type === "fill") {
        const r = await driver.fill({ label: step.label, testId: step.testId, value: step.value });
        if (!r.ok) throw r.error;
      } else if (step.type === "wait-visible") {
        const r = await driver.waitForVisible(step);
        if (!r.ok) throw r.error;
      } else if (step.type === "wait") await new Promise((resolve) => setTimeout(resolve, step.ms));
      else if (step.type === "checkpoint") {
        /* checkpoint callback runs after settlement */
      }
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
      await options?.afterStep?.(step, receipt);
      if (step.type === "checkpoint") {
        await options?.onCheckpoint?.(step.id, step.id);
        if (options?.stopAtCheckpoint === step.id) break;
      }
    } catch (cause) {
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
  }
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
