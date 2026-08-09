import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Driver } from "../src/driver/driver";
import { JourneyError } from "../src/journey";
import type { Scenario } from "../src/types/chaos";
import { ok } from "../src/types/result";

const scenario: Scenario = {
  id: "scenario-1",
  name: "GET /api → Service Unavailable",
  description: "test",
  category: "error",
  priority: 1,
  endpoint: {
    method: "GET",
    pattern: "https://app.test/api",
    resourceTypes: ["xhr"],
    replayed: true,
  },
  endpointType: "api",
};

const scan = vi.fn();
const probeScenarios = vi.fn();
const createPlaywrightDriver = vi.fn();

vi.mock("../src/capture/capture", () => ({ scan }));
vi.mock("../src/cli/probe", () => ({ probeScenarios }));
vi.mock("../src/driver/playwright", () => ({ createPlaywrightDriver }));

const { commandChaos } = await import("../src/cli/commands");

describe("commandChaos authentication failures", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const discoveryDriver = {
      currentUrl: () => "https://app.test/",
      recordingPath: async () => null,
      close: async () => undefined,
    } as Driver;
    createPlaywrightDriver.mockResolvedValue(ok(discoveryDriver));
    scan.mockResolvedValue(
      ok({
        endpoints: [scenario.endpoint],
        scenarios: [scenario],
        exchangeCount: 1,
      }),
    );
  });

  it("returns the typed auth remediation and does not start proof after auth expires between discovery and probe", async () => {
    probeScenarios.mockResolvedValue([
      {
        scenario: { id: scenario.id, name: scenario.name, category: "error", endpoint: "GET /api" },
        appeared: [],
        disappeared: [],
        unchangedCount: 0,
        receipts: [],
        matchedCount: 0,
        appliedCount: 0,
        proof: { baselineShot: null, faultedShot: null, video: null },
        error: 'Authentication expired for profile "staging". Re-run tremor auth login staging.',
        failureKind: "authentication",
        journeyFailure: {
          kind: "authentication",
          journeyId: "checkout",
          stepId: "account",
          action: "authentication",
          receipts: [
            {
              journeyId: "checkout",
              stepId: "start",
              type: "navigate",
              status: "completed",
            },
          ],
        },
      },
    ]);

    const result = await commandChaos(
      {
        url: "https://app.test/",
        runDir: "/tmp/tremor-command-auth",
        headless: true,
        waitUntil: "load",
        timeoutMs: 1_000,
        viewport: { width: 800, height: 600 },
        video: false,
        authSelection: { kind: "profile", name: "staging" },
      },
      [],
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(JourneyError);
      expect(result.error.message).toBe(
        'Authentication expired for profile "staging". Re-run tremor auth login staging.',
      );
      expect(result.error).toMatchObject({
        kind: "authentication",
        journeyId: "checkout",
        stepId: "account",
        action: "authentication",
        receipts: [
          {
            journeyId: "checkout",
            stepId: "start",
            type: "navigate",
            status: "completed",
          },
        ],
      });
    }
    expect(probeScenarios).toHaveBeenCalledTimes(1);
    expect(probeScenarios).toHaveBeenCalledWith(expect.anything(), expect.anything(), 4, "smoke");
    expect(probeScenarios).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      "proof",
    );
  });
});
