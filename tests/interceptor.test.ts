import { describe, expect, it } from "vitest";
import { presetInterceptor, scenarioInterceptor } from "../src/chaos/interceptor";
import type { InterceptedRequest } from "../src/driver/driver";
import type { ChaosPreset, Scenario } from "../src/types/chaos";

function req(overrides: Partial<InterceptedRequest> = {}): InterceptedRequest {
  return {
    method: "GET",
    url: "https://app.test/api/users",
    resourceType: "xhr",
    headers: {},
    postData: null,
    ...overrides,
  };
}

function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    id: "s1",
    name: "test",
    description: "",
    category: "error",
    priority: 1,
    endpoint: { method: "GET", pattern: "https://app.test/api/users" },
    endpointType: "api",
    ...overrides,
  };
}

describe("scenarioInterceptor", () => {
  it("serves the mock when the request matches", async () => {
    const i = scenarioInterceptor(
      scenario({
        mock: {
          status: 503,
          statusText: "Service Unavailable",
          headers: { "content-type": "application/json" },
          body: '{"error":"down"}',
          delay: 0,
        },
      }),
    );

    const decision = await i(req());
    expect(decision.action).toBe("fulfill");
    if (decision.action === "fulfill") {
      expect(decision.status).toBe(503);
      expect(decision.body).toBe('{"error":"down"}');
    }
  });

  it("leaves non-matching URLs alone", async () => {
    const i = scenarioInterceptor(scenario({ mock: mock503() }));
    expect((await i(req({ url: "https://app.test/api/orders" }))).action).toBe("continue");
  });

  it("leaves non-matching methods alone", async () => {
    const i = scenarioInterceptor(scenario({ mock: mock503() }));
    expect((await i(req({ method: "POST" }))).action).toBe("continue");
  });

  it("returns a transform for corruption so the real payload is mutated", async () => {
    const i = scenarioInterceptor(
      scenario({
        category: "corruption",
        effect: { type: "corrupt", mutations: [{ field: "name", action: "nullify" }] },
      }),
    );

    const decision = await i(req());
    expect(decision.action).toBe("transform");
    if (decision.action === "transform") {
      const out = await decision.transform({
        status: 200,
        headers: {},
        body: '{"name":"ada","id":7}',
      });
      expect(JSON.parse(out.body)).toEqual({ name: null, id: 7 });
      expect(out.status).toBe(200);
    }
  });

  it("aborts as a timeout when a timeout effect fires", async () => {
    const i = scenarioInterceptor(scenario({ effect: { type: "timeout", rate: 1, afterMs: 0 } }));
    const decision = await i(req());
    expect(decision).toEqual({ action: "abort", reason: "timedout" });
  });

  it("continues when a rated effect does not fire", async () => {
    const i = scenarioInterceptor(scenario({ effect: { type: "error", status: 500, rate: 0 } }));
    expect((await i(req())).action).toBe("continue");
  });

  it("does nothing when the scenario carries neither mock nor effect", async () => {
    expect((await scenarioInterceptor(scenario())(req())).action).toBe("continue");
  });
});

describe("presetInterceptor", () => {
  const preset = (overrides: Partial<ChaosPreset["rules"][number]> = {}): ChaosPreset => ({
    id: "p",
    name: "p",
    description: "",
    rules: [
      {
        name: "api-down",
        enabled: true,
        match: { urlPattern: "**", resourceTypes: ["xhr", "fetch"] },
        effects: [{ type: "error", status: 503, rate: 1 }],
        ...overrides,
      },
    ],
  });

  it("only touches the resource types the rule targets", async () => {
    const i = presetInterceptor(preset());
    expect((await i(req({ resourceType: "xhr" }))).action).toBe("fulfill");
    // The page shell must still load, or every finding is just "blank page".
    expect((await i(req({ resourceType: "document" }))).action).toBe("continue");
  });

  it("enforces target origin and GET safety while retaining scenario metadata", async () => {
    const i = presetInterceptor(preset(), {
      scenarioId: "scenario-p",
      targetOrigin: "https://app.test",
    });
    const applied = await i(req());
    expect(applied.action).toBe("fulfill");
    expect(applied.scenarioId).toBe("scenario-p");
    expect(applied.faultId).toBe("scenario-p:api-down");
    expect((await i(req({ method: "POST" }))).action).toBe("continue");
    expect((await i(req({ url: "https://other.test/api/users" }))).action).toBe("continue");
  });

  it("preserves multiple rule order and complete effects", async () => {
    const multi: ChaosPreset = {
      id: "multi",
      name: "multi",
      description: "",
      rules: [
        {
          name: "documents-only",
          enabled: true,
          match: { urlPattern: "**", resourceTypes: ["document"] },
          effects: [{ type: "error", status: 500, rate: 1 }],
        },
        {
          name: "api-delay",
          enabled: true,
          match: { urlPattern: "**", resourceTypes: ["xhr"] },
          effects: [{ type: "latency", ms: 0, distribution: "fixed" }],
        },
      ],
    };
    const decision = await presetInterceptor(multi, { scenarioId: "scenario-multi" })(req());
    expect(decision.action).toBe("continue");
    expect(decision.matched).toBe(true);
    expect(decision.scenarioId).toBe("scenario-multi");
  });

  it("skips disabled rules", async () => {
    const i = presetInterceptor(preset({ enabled: false }));
    expect((await i(req())).action).toBe("continue");
  });

  it("stops failing once failCount is exhausted", async () => {
    const i = presetInterceptor(preset({ failCount: 2 }));
    expect((await i(req())).action).toBe("fulfill");
    expect((await i(req())).action).toBe("fulfill");
    expect((await i(req())).action).toBe("continue");
    expect((await i(req())).action).toBe("continue");
  });

  it("keeps failCount per interceptor instance, not global", async () => {
    const p = preset({ failCount: 1 });
    const first = presetInterceptor(p);
    await first(req());
    expect((await first(req())).action).toBe("continue");

    const second = presetInterceptor(p);
    expect((await second(req())).action).toBe("fulfill");
  });
});

function mock503() {
  return {
    status: 503,
    statusText: "Service Unavailable",
    headers: {},
    body: "{}",
    delay: 0,
  };
}
