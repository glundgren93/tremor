import type { AuthGuardResult } from "./auth/guard";
import type { Driver, NavigateOptions } from "./driver/driver";
import { JourneyError, type JourneyStep, resolveSameOriginPath } from "./journey";

type JourneyGuard = Extract<Awaited<ReturnType<Driver["installJourneySafetyGuard"]>>, { ok: true }>;
export type JourneyExecutionOptions = {
  navigate?: NavigateOptions;
  authGuard?: () => AuthGuardResult;
};

async function executeNavigate(
  driver: Driver,
  step: Extract<JourneyStep, { type: "navigate" }>,
  target: URL,
  options: JourneyExecutionOptions,
  guard: JourneyGuard,
) {
  const destination = resolveSameOriginPath(step.path, target.href);
  if (!destination) throw new JourneyError("navigation-blocked", step.id, step.type);
  guard.value.authorizeNavigation?.(destination.href);
  const result = await driver.navigate(destination.href, options.navigate);
  if (!result.ok || driver.currentUrl() !== destination.href)
    throw new JourneyError("navigation-blocked", step.id, step.type);
  await driver.waitForIdle();
  const auth = options.authGuard?.();
  if (auth && !auth.ok)
    throw new JourneyError("authentication", step.id, "authentication", auth.message);
}

async function executeClick(
  driver: Driver,
  step: Extract<JourneyStep, { type: "click" }>,
  target: URL,
  options: JourneyExecutionOptions,
  guard: JourneyGuard,
) {
  const before = driver.currentUrl();
  const expected = step.expectPath
    ? resolveSameOriginPath(step.expectPath, target.href)
    : undefined;
  if (step.expectPath && !expected)
    throw new JourneyError("navigation-blocked", step.id, step.type);
  if (expected) guard.value.authorizeNavigation?.(expected.href);
  const result = await driver.click({
    role: step.role,
    name: step.name,
    label: step.label,
    testId: step.testId,
  });
  if (!result.ok) throw result.error;
  const actual = new URL(driver.currentUrl());
  if (
    actual.origin !== target.origin ||
    (expected ? actual.href !== expected.href : actual.href !== before)
  )
    throw new JourneyError("navigation-blocked", step.id, step.type);
  if (actual.href !== before) {
    const auth = options.authGuard?.();
    if (auth && !auth.ok)
      throw new JourneyError("authentication", step.id, "authentication", auth.message);
  }
}

export async function executeStep(
  driver: Driver,
  step: JourneyStep,
  target: URL,
  options: JourneyExecutionOptions,
  guard: JourneyGuard,
): Promise<void> {
  if (step.type === "navigate") return executeNavigate(driver, step, target, options, guard);
  if (step.type === "click") return executeClick(driver, step, target, options, guard);
  if (step.type === "fill") {
    const result = await driver.fill({ label: step.label, testId: step.testId, value: step.value });
    if (!result.ok) throw result.error;
    return;
  }
  if (step.type === "wait-visible") {
    const result = await driver.waitForVisible(step);
    if (!result.ok) throw result.error;
    return;
  }
  if (step.type === "wait") await new Promise((resolve) => setTimeout(resolve, step.ms));
}
