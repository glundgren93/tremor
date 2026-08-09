import { describe, expect, it } from "vitest";
import type { Driver } from "../src/driver/driver";
import { parseJourney, runJourney } from "../src/journey";
import { ok } from "../src/types/result";

describe("JourneyFile v1", () => {
  it("accepts semantic actions and checkpoints", () => {
    const result = parseJourney({
      version: 1,
      id: "reports",
      steps: [
        { id: "open", type: "click", role: "button", name: "Open report" },
        { id: "query", type: "fill", label: "Search", value: "revenue" },
        { id: "loaded", type: "wait-visible", role: "status", name: "Results" },
        { id: "results", type: "checkpoint" },
      ],
    });
    expect(result.ok).toBe(true);
  });
  it("rejects unknown keys, duplicate ids, unsafe navigation, and missing checkpoints", () => {
    expect(
      parseJourney({
        version: 1,
        id: "x",
        steps: [
          { id: "a", type: "wait", ms: 1, extra: true },
          { id: "c", type: "checkpoint" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseJourney({
        version: 1,
        id: "x",
        steps: [
          { id: "a", type: "wait", ms: 1 },
          { id: "a", type: "checkpoint" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseJourney({
        version: 1,
        id: "x",
        steps: [
          { id: "a", type: "navigate", path: "https://evil.test" },
          { id: "c", type: "checkpoint" },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseJourney({ version: 1, id: "x", steps: [{ id: "a", type: "wait", ms: 1 }] }).ok,
    ).toBe(false);
  });

  it("enforces the durable schema", () => {
    const base = { version: 1, id: "valid", steps: [{ id: "done", type: "checkpoint" }] };
    expect(parseJourney({ ...base, extra: true }).ok).toBe(false);
    expect(parseJourney({ ...base, id: "1invalid" }).ok).toBe(false);
    expect(
      parseJourney({
        ...base,
        steps: [{ id: "go", type: "navigate", path: "//evil.test" }, ...base.steps],
      }).ok,
    ).toBe(false);
    expect(
      parseJourney({
        ...base,
        steps: [{ id: "click", type: "click", label: "", expectPath: "/" }, ...base.steps],
      }).ok,
    ).toBe(false);
    expect(
      parseJourney({
        ...base,
        steps: [
          { id: "done", type: "checkpoint" },
          { id: "later", type: "wait", ms: 1 },
        ],
      }).ok,
    ).toBe(false);
    expect(
      parseJourney({ ...base, steps: [{ id: "done", type: "checkpoint", idempotent: true }] }).ok,
    ).toBe(false);
  });

  it("rejects encoded controls and dot segments in declared paths", () => {
    for (const path of ["/safe%00x", "/safe%1fx", "/safe%7fx", "/%2e%2e/secret"]) {
      expect(
        parseJourney({
          version: 1,
          id: "encoded",
          steps: [
            { id: "go", type: "navigate", path },
            { id: "done", type: "checkpoint" },
          ],
        }).ok,
      ).toBe(false);
      expect(
        parseJourney({
          version: 1,
          id: "encoded",
          steps: [
            { id: "go", type: "click", testId: "go", expectPath: path },
            { id: "done", type: "checkpoint" },
          ],
        }).ok,
      ).toBe(false);
    }
  });

  it("blocks unsafe encoded paths at runtime before navigate or click", async () => {
    for (const step of [
      { id: "go", type: "navigate", path: "/%2e%2e/secret" },
      { id: "go", type: "click", testId: "go", expectPath: "/safe%00x" },
    ] as const) {
      let navigations = 0;
      let clicks = 0;
      const driver = {
        navigate: async () => {
          navigations++;
          return ok({ url: "https://app.test/", status: 200, durationMs: 1 });
        },
        click: async () => {
          clicks++;
          return ok(undefined);
        },
        currentUrl: () => "https://app.test/",
        waitForIdle: async () => ok(undefined),
        installJourneySafetyGuard: async () =>
          ok({ authorizeNavigation: () => {}, dispose: async () => {} }),
      } as unknown as Driver;
      const result = await runJourney(
        driver,
        { version: 1, id: "runtime", steps: [step, { id: "done", type: "checkpoint" }] },
        "https://app.test/",
      );
      expect(result.ok).toBe(false);
      expect(navigations).toBe(1);
      expect(clicks).toBe(0);
    }
  });

  it("returns unsafe-request-blocked when the guard observed an aborted request", async () => {
    const driver = {
      navigate: async () => ok({ url: "https://app.test", status: 200, durationMs: 1 }),
      currentUrl: () => "https://app.test/",
      waitForIdle: async () => ok(undefined),
      installJourneySafetyGuard: async () => ok({ blocked: true, dispose: async () => {} }),
    } as unknown as Driver;
    const parsed = parseJourney({
      version: 1,
      id: "unsafe",
      steps: [{ id: "done", type: "checkpoint" }],
    });
    if (!parsed.ok) throw parsed.error;
    const result = await runJourney(driver, parsed.value, "https://app.test/");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe("unsafe-request-blocked");
  });

  it("guards authentication immediately after bootstrap and declared navigation", async () => {
    const calls: string[] = [];
    const driver = {
      navigate: async () => {
        calls.push("navigate");
        return ok({ url: "https://app.test/next", status: 200, durationMs: 1 });
      },
      currentUrl: () => "https://app.test/next",
      waitForIdle: async () => {
        calls.push("idle");
        return ok(undefined);
      },
      installJourneySafetyGuard: async () => {
        calls.push("install-guard");
        return ok({
          authorizeNavigation: (url: string) => calls.push(`authorize:${url}`),
          dispose: async () => {},
        });
      },
    } as unknown as Driver;
    const parsed = parseJourney({
      version: 1,
      id: "auth-order",
      steps: [
        { id: "next", type: "navigate", path: "/next" },
        { id: "done", type: "checkpoint" },
      ],
    });
    if (!parsed.ok) throw parsed.error;
    const result = await runJourney(driver, parsed.value, "https://app.test/next", {
      authGuard: () => {
        calls.push("auth");
        return { ok: true };
      },
    });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      "navigate",
      "idle",
      "auth",
      "install-guard",
      "authorize:https://app.test/next",
      "navigate",
      "idle",
      "auth",
      "idle",
      "idle",
    ]);
  });

  it("preserves authentication remediation and structured provenance", async () => {
    const driver = {
      navigate: async () => ok({ url: "https://login.test/", status: 200, durationMs: 1 }),
      currentUrl: () => "https://login.test/",
      waitForIdle: async () => ok(undefined),
      installJourneySafetyGuard: async () =>
        ok({ authorizeNavigation: () => {}, dispose: async () => {} }),
    } as unknown as Driver;
    const parsed = parseJourney({
      version: 1,
      id: "private-flow",
      steps: [{ id: "done", type: "checkpoint" }],
    });
    if (!parsed.ok) throw parsed.error;
    const result = await runJourney(driver, parsed.value, "https://app.test/", {
      authGuard: () => ({ ok: false, message: "Authentication required; use --profile." }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toMatchObject({
      kind: "authentication",
      journeyId: "private-flow",
      action: "authentication",
      receipts: [],
      message: "Authentication required; use --profile.",
    });
  });

  it("bootstraps, executes semantic steps, settles, and keeps failures secret-safe", async () => {
    const calls: string[] = [];
    let disposed = false;
    const driver = {
      navigate: async () => {
        calls.push("navigate");
        return ok({ url: "https://app.test/", status: 200, durationMs: 1 });
      },
      currentUrl: () => "https://app.test/",
      waitForIdle: async () => {
        calls.push("idle");
        return ok(undefined);
      },
      installJourneySafetyGuard: async () =>
        ok({
          dispose: async () => {
            disposed = true;
          },
        }),
      fill: async () => {
        calls.push("fill");
        return { ok: false, error: new Error("selector [secret-value]") } as const;
      },
    } as unknown as Driver;
    const parsed = parseJourney({
      version: 1,
      id: "safe",
      steps: [
        { id: "secret", type: "fill", label: "Token", value: "secret-value" },
        { id: "done", type: "checkpoint" },
      ],
    });
    if (!parsed.ok) throw parsed.error;
    const result = await runJourney(driver, parsed.value, "https://app.test");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failure");
    expect(result.error.kind).toBe("step-failed");
    expect(result.error.message).not.toContain("secret-value");
    expect(calls).toEqual(["navigate", "idle", "fill"]);
    expect(disposed).toBe(true);
  });
});
