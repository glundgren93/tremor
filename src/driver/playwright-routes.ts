import type { Route } from "playwright";
import { DEFAULT_REDACTION_CONFIG, redactUrl } from "../capture/redaction";
import type { FaultReceipt } from "../types/chaos";
import type { InterceptDecision, InterceptedRequest, Interceptor } from "./driver";

export type RouteReceipt = (
  req: InterceptedRequest,
  decision: InterceptDecision,
  status: FaultReceipt["status"],
  error?: string,
) => void;

export function createRouteHandler(
  interceptor: Interceptor,
  receipt: RouteReceipt,
): (route: Route) => Promise<void> {
  return async (route) => {
    const request = route.request();
    const intercepted: InterceptedRequest = {
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      headers: request.headers(),
      postData: request.postData(),
    };
    let decision: InterceptDecision;
    try {
      decision = await interceptor(intercepted);
    } catch (e) {
      receipt(
        intercepted,
        { action: "abort", reason: "failed", faultId: "unknown" },
        "error",
        String(e),
      );
      await route.abort("failed").catch(() => {});
      return;
    }
    if (!decision.suppressReceipt)
      receipt(intercepted, decision, decision.matched ? "matched" : "pass-through");
    try {
      await applyRouteDecision(route, intercepted, decision, receipt);
    } catch (e) {
      if (!decision.suppressReceipt) receipt(intercepted, decision, "error", String(e));
      await route.abort("failed").catch(() => {});
    }
  };
}

async function applyRouteDecision(
  route: Route,
  req: InterceptedRequest,
  decision: InterceptDecision,
  receipt: RouteReceipt,
): Promise<void> {
  if (
    Number.isFinite(decision.preDelayMs) &&
    decision.preDelayMs !== undefined &&
    decision.preDelayMs > 0
  )
    await sleep(decision.preDelayMs);
  if (decision.action === "fulfill")
    await route.fulfill({
      status: decision.status,
      headers: decision.headers,
      body: decision.body,
    });
  else if (decision.action === "abort") await route.abort(decision.reason);
  else if (decision.action === "delay") {
    await sleep(decision.ms);
    await route.fallback();
  } else if (decision.action === "transform") {
    const real = await route.fetch();
    const mutated = await decision.transform({
      status: real.status(),
      headers: real.headers(),
      body: await real.text(),
    });
    await route.fulfill({ status: mutated.status, headers: mutated.headers, body: mutated.body });
  } else await route.fallback();
  if (decision.action !== "continue" && decision.matched && !decision.suppressReceipt)
    receipt(req, decision, "applied");
}

export function createFaultReceipt(
  req: InterceptedRequest,
  decision: InterceptDecision,
  status: FaultReceipt["status"],
  error?: string,
): FaultReceipt {
  return {
    version: 1,
    status,
    scenarioId: decision.scenarioId ?? "unknown",
    faultId: decision.faultId ?? decision.action,
    method: req.method,
    url: redactUrl(req.url, DEFAULT_REDACTION_CONFIG),
    resourceType: req.resourceType,
    action: decision.action,
    httpStatus: "status" in decision ? decision.status : undefined,
    ...((decision.action === "delay" || decision.preDelayMs !== undefined) &&
    decision.delayKind !== undefined &&
    decision.delayKind !== "mixed"
      ? {
          faultType: decision.delayKind,
          delayMs: decision.action === "delay" ? decision.ms : decision.preDelayMs,
        }
      : decision.action === "delay" || decision.preDelayMs !== undefined
        ? { delayMs: decision.action === "delay" ? decision.ms : decision.preDelayMs }
        : {}),
    timestamp: Date.now(),
    ...(error ? { error } : {}),
  };
}
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
