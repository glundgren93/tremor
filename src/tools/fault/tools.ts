import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { applyEffectPipeline } from "../../core/chaos";
import { deduplicateEndpoints, filterEndpoints } from "../../core/endpoints";
import { generateId } from "../../core/id";
import { matchesRequest } from "../../core/matcher";
import { installDiagnostics } from "../../core/page-diagnostics";
import { PRESETS } from "../../core/presets";
import { redactUrl } from "../../core/redaction";
import { listScenarioFiles, loadScenariosFromFile, saveScenariosToFile } from "../../core/scenario-files";
import { generateScenarios } from "../../core/scenarios";
import type { HttpMethod } from "../../core/types";
import { WEB_VITALS_INIT_SCRIPT } from "../../core/web-vitals";
import { type ActiveFault, state, type WorkerContext } from "../../state";
import { applyScenario, buildChaosEffect } from "./helpers";

export function faultTools(ctx?: WorkerContext) {
  return [
    tool(
      "fault_generate_scenarios",
      "Generate fault scenarios from captured network traffic",
      {
        categories: z
          .array(z.enum(["error", "timing", "empty", "corruption"]))
          .optional()
          .describe("Categories to generate (default: all)"),
        filter: z
          .string()
          .optional()
          .describe("Filter endpoints by path substring (e.g. /api/checkout)"),
      },
      async ({ categories, filter }) => {
        let endpoints = deduplicateEndpoints(state.capturedRequests);
        if (filter) {
          endpoints = filterEndpoints(endpoints, filter);
        }
        if (endpoints.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No API endpoints captured yet. Navigate around the app to capture network traffic first.",
              },
            ],
          };
        }
        const scenarios = generateScenarios(endpoints, categories ? { categories } : undefined);
        state.generatedScenarios = scenarios;

        const byEndpoint = new Map<string, { categories: Map<string, number>; names: string[] }>();
        for (const s of scenarios) {
          const key = redactUrl(s.endpoint.pattern, state.redactionConfig);
          const label = `${s.endpoint.method} ${key}`;
          if (!byEndpoint.has(label)) {
            byEndpoint.set(label, { categories: new Map(), names: [] });
          }
          // biome-ignore lint/style/noNonNullAssertion: guaranteed by has() check above
          const group = byEndpoint.get(label)!;
          group.categories.set(s.category, (group.categories.get(s.category) ?? 0) + 1);
          group.names.push(redactUrl(s.name, state.redactionConfig));
        }

        const lines = Array.from(byEndpoint.entries()).map(([label, group]) => {
          const cats = Array.from(group.categories.entries())
            .map(([cat, count]) => `${count} ${cat}`)
            .join(", ");
          return `  ${label} (${cats})`;
        });

        return {
          content: [
            {
              type: "text",
              text: `Generated ${scenarios.length} scenarios from ${endpoints.length} endpoints:\n${lines.join("\n")}\n\nUse fault_apply with a scenario name to apply one.`,
            },
          ],
        };
      },
    ),

    tool(
      "fault_apply",
      "Apply a generated fault scenario by ID or name",
      {
        scenario: z.string().describe("Scenario ID or name to apply"),
        failCount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Number of times to fail before letting requests succeed (for testing retry/recovery). Omit for always-fail.",
          ),
      },
      async ({ scenario: scenarioRef, failCount }) => {
        const page = ctx?.page ?? state.page;
        if (!page) {
          return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
        }
        const found = state.generatedScenarios.find(
          (s) => s.id === scenarioRef || s.name === scenarioRef,
        );
        if (!found) {
          return {
            content: [
              {
                type: "text",
                text: `Scenario "${scenarioRef}" not found. Use fault_generate_scenarios first.`,
              },
            ],
            isError: true,
          };
        }
        const fault = await applyScenario(found, failCount, ctx);
        const redactedName = redactUrl(found.name, state.redactionConfig);
        const redactedDesc = redactUrl(found.description, state.redactionConfig);
        const failCountNote =
          failCount !== undefined
            ? `\nStateful: will fail ${failCount} time${failCount === 1 ? "" : "s"} then allow requests through.`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `Applied scenario: "${redactedName}" (${found.category}) [fault:${fault.id}]\n${redactedDesc}${failCountNote}`,
            },
          ],
        };
      },
    ),

    tool(
      "fault_apply_preset",
      "Apply a built-in chaos preset",
      {
        preset: z
          .enum([
            "backend-down",
            "slow-network",
            "flaky",
            "timeout-chaos",
            "empty-response",
            "auth-cascade",
          ])
          .describe("Preset to apply"),
        failCount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Number of times each rule fails before letting requests succeed (for testing retry/recovery). Omit for always-fail.",
          ),
      },
      async ({ preset: presetId, failCount }) => {
        const page = ctx?.page ?? state.page;
        if (!page) {
          return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
        }
        const preset = PRESETS.find((p) => p.id === presetId);
        if (!preset) {
          return {
            content: [{ type: "text", text: `Preset "${presetId}" not found.` }],
            isError: true,
          };
        }

        const handlers: Array<(route: import("playwright").Route) => Promise<void>> = [];
        for (const rule of preset.rules) {
          if (!rule.enabled) continue;
          let failures = 0;
          const handler = async (route: import("playwright").Route) => {
            const request = route.request();
            if (
              rule.match.resourceTypes &&
              rule.match.resourceTypes.length > 0 &&
              !rule.match.resourceTypes.includes(request.resourceType())
            ) {
              await route.fallback();
              return;
            }
            if (!matchesRequest(rule.match, request.method(), request.url(), request.headers())) {
              await route.fallback();
              return;
            }
            const effectiveFailCount = rule.failCount ?? failCount;
            if (effectiveFailCount !== undefined && failures >= effectiveFailCount) {
              await route.fallback();
              return;
            }
            const result = await applyEffectPipeline(route, rule.effects);
            if (result.fired) failures++;
            return;
          };
          await page.route("**/*", handler);
          handlers.push(handler);
        }

        const faultId = generateId();
        const activeFaults = ctx?.activeFaults ?? state.activeFaults;

        // Derive category from the preset's effect types
        const effectTypes = new Set(
          preset.rules.flatMap((r) => r.effects.map((e) => e.type)),
        );
        const category = effectTypes.has("error") && effectTypes.has("latency")
          ? "error; timing"
          : effectTypes.has("error")
            ? "error"
            : effectTypes.has("timeout")
              ? "timing"
              : effectTypes.has("latency")
                ? "timing"
                : effectTypes.has("mock")
                  ? "empty"
                  : effectTypes.has("corrupt")
                    ? "corruption"
                    : "error";

        const fault: ActiveFault = {
          id: faultId,
          endpoint: preset.name,
          category,
          source: "preset",
          handlers,
        };
        activeFaults.push(fault);

        const failCountNote =
          failCount !== undefined
            ? `\nStateful: each rule will fail ${failCount} time${failCount === 1 ? "" : "s"} then allow requests through.`
            : "";
        return {
          content: [
            {
              type: "text",
              text: `Applied preset: "${preset.name}" — ${preset.description} [fault:${faultId}]${failCountNote}`,
            },
          ],
        };
      },
    ),

    tool(
      "fault_apply_custom",
      "Apply a custom fault rule with URL pattern, mock response, and/or chaos effect",
      {
        urlPattern: z.string().describe("URL glob pattern to match (e.g., **/api/users/*)"),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
          .optional()
          .describe("HTTP method to match"),
        response: z
          .object({
            status: z.number().describe("Response status code"),
            body: z.string().describe("Response body"),
            headers: z.record(z.string(), z.string()).optional().describe("Response headers"),
          })
          .optional()
          .describe("Mock response to return"),
        effect: z
          .object({
            type: z.enum(["latency", "error", "timeout"]).describe("Effect type"),
            ms: z.number().optional().describe("Delay in ms (for latency)"),
            status: z.number().optional().describe("Error status code (for error)"),
            rate: z.number().optional().describe("Probability 0-1 (for error/timeout)"),
          })
          .optional()
          .describe("Chaos effect to apply"),
        effects: z
          .array(
            z.object({
              type: z.enum(["latency", "error", "timeout"]).describe("Effect type"),
              ms: z.number().optional().describe("Delay in ms (for latency)"),
              status: z.number().optional().describe("Error status code (for error)"),
              rate: z.number().optional().describe("Probability 0-1 (for error/timeout)"),
            }),
          )
          .optional()
          .describe("Compound effects pipeline (delay effects stack, first terminal wins)"),
        failCount: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Number of times to fail before letting requests succeed (for testing retry/recovery). Omit for always-fail.",
          ),
      },
      async ({ urlPattern, method, response, effect, effects, failCount }) => {
        const page = ctx?.page ?? state.page;
        if (!page) {
          return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
        }

        let failures = 0;
        const handler = async (route: import("playwright").Route) => {
          const request = route.request();
          const matcher = { urlPattern, method: method as HttpMethod | undefined };
          if (!matchesRequest(matcher, request.method(), request.url(), request.headers())) {
            await route.fallback();
            return;
          }
          if (failCount !== undefined && failures >= failCount) {
            await route.fallback();
            return;
          }
          if (response) {
            await route.fulfill({
              status: response.status,
              headers: response.headers ?? { "content-type": "application/json" },
              body: response.body,
            });
            failures++;
            return;
          }
          // effects (compound pipeline) takes precedence over singular effect
          const effectsList = effects
            ? effects
                .map((e) => buildChaosEffect(e))
                .filter((e): e is NonNullable<typeof e> => e !== null)
            : effect
              ? [buildChaosEffect(effect)].filter((e): e is NonNullable<typeof e> => e !== null)
              : [];
          if (effectsList.length > 0) {
            const result = await applyEffectPipeline(route, effectsList);
            if (result.fired) failures++;
            return;
          }
          await route.continue();
        };

        await page.route("**/*", handler);
        const faultId = generateId();
        const activeFaults = ctx?.activeFaults ?? state.activeFaults;
        const fault: ActiveFault = {
          id: faultId,
          endpoint: `${method ?? "*"} ${urlPattern}`,
          category:
            effect?.type === "latency" ? "timing" : response ? "error" : (effect?.type ?? "error"),
          source: "custom",
          handlers: [handler],
        };
        activeFaults.push(fault);

        const parts: string[] = [`URL: ${urlPattern}`];
        if (method) parts.push(`Method: ${method}`);
        if (response) parts.push(`Mock: ${response.status}`);
        if (effects) parts.push(`Effects: ${effects.map((e) => e.type).join(" + ")}`);
        else if (effect) parts.push(`Effect: ${effect.type}`);
        if (failCount !== undefined)
          parts.push(
            `Stateful: fail ${failCount} time${failCount === 1 ? "" : "s"} then allow requests through`,
          );
        return {
          content: [
            {
              type: "text",
              text: `Applied custom fault rule [fault:${faultId}]:\n${parts.join("\n")}`,
            },
          ],
        };
      },
    ),

    tool("fault_reset", "Remove all active fault injections and route overrides", {}, async () => {
      const page = ctx?.page ?? state.page;
      if (!page) {
        return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
      }
      await page.unrouteAll({ behavior: "ignoreErrors" });
      if (ctx) {
        ctx.activeFaults = [];
      } else {
        state.activeFaults = [];
      }

      // Cycle pages for per-scenario video recording:
      // Close the current page (finalizes its video) and create a new one (starts a new video)
      if (ctx && state.context && ctx.targetUrl) {
        try {
          const oldPage = ctx.page;
          const newPage = await state.context.newPage();
          await newPage.addInitScript(WEB_VITALS_INIT_SCRIPT);
          installDiagnostics(newPage);
          await newPage.goto(ctx.targetUrl, { waitUntil: "load", timeout: 30000 });
          ctx.page = newPage;
          if (ctx.onPageChanged) {
            await ctx.onPageChanged(oldPage, newPage);
          }
          await oldPage.close();
        } catch {
          // Context may be closing due to test stop — ignore page cycling errors
        }
      }

      return { content: [{ type: "text", text: "All fault injections and routes cleared." }] };
    }),

    tool("fault_list", "List all active fault injections with their IDs", {}, async () => {
      const activeFaults = ctx?.activeFaults ?? state.activeFaults;
      const parts: string[] = [];

      if (activeFaults.length === 0) {
        parts.push("No active faults.");
      } else {
        const lines = activeFaults.map(
          (f, i) => `${i + 1}. [${f.id}] ${f.endpoint} (${f.category}, ${f.source})`,
        );
        parts.push(`Active faults:\n${lines.join("\n")}`);
      }

      if (state.cpuThrottleRate > 1) {
        parts.push(
          `\nEnvironment: CPU throttle ${state.cpuThrottleRate}x (use device_set_cpu_throttle to change)`,
        );
      }

      return { content: [{ type: "text", text: parts.join("\n") }] };
    }),

    tool(
      "fault_remove",
      "Remove a specific active fault by its ID",
      { faultId: z.string().describe("The fault ID to remove (from fault_list)") },
      async ({ faultId }) => {
        const page = ctx?.page ?? state.page;
        if (!page) {
          return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
        }
        const activeFaults = ctx?.activeFaults ?? state.activeFaults;
        const index = activeFaults.findIndex((f) => f.id === faultId);
        if (index === -1) {
          return {
            content: [
              {
                type: "text",
                text: `Fault "${faultId}" not found. Use fault_list to see active faults.`,
              },
            ],
            isError: true,
          };
        }
        // biome-ignore lint/style/noNonNullAssertion: guaranteed by findIndex check above
        const fault = activeFaults[index]!;
        for (const handler of fault.handlers) {
          await page.unroute("**/*", handler);
        }
        activeFaults.splice(index, 1);
        return {
          content: [
            {
              type: "text",
              text: `Removed fault: ${fault.endpoint} (${fault.category}, ${fault.source})`,
            },
          ],
        };
      },
    ),

    tool(
      "scenarios_save",
      "Save generated scenarios to a file for reuse",
      {
        name: z.string().optional().describe("Optional name for the scenario file"),
      },
      async ({ name }) => {
        if (state.generatedScenarios.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "No scenarios to save. Use fault_generate_scenarios first.",
              },
            ],
            isError: true,
          };
        }
        const url = state.page?.url() ?? "unknown";
        const result = saveScenariosToFile(state.generatedScenarios, url, { name });
        return {
          content: [
            {
              type: "text",
              text: `Saved ${result.count} scenarios to .tremor/scenarios/${result.file}`,
            },
          ],
        };
      },
    ),

    tool(
      "scenarios_load",
      "Load scenarios from a saved file",
      {
        file: z.string().describe("Scenario filename to load (from scenarios_list or scenarios_save)"),
      },
      async ({ file }) => {
        try {
          const data = loadScenariosFromFile(file);
          state.generatedScenarios = data.scenarios;
          return {
            content: [
              {
                type: "text",
                text: `Loaded ${data.scenarios.length} scenarios from ${file} (URL: ${data.url}${data.filter ? `, filter: ${data.filter}` : ""})`,
              },
            ],
          };
        } catch (err) {
          return {
            content: [
              {
                type: "text",
                text: err instanceof Error ? err.message : String(err),
              },
            ],
            isError: true,
          };
        }
      },
    ),

    tool(
      "scenarios_list_files",
      "List saved scenario files",
      {},
      async () => {
        const files = listScenarioFiles();
        if (files.length === 0) {
          return { content: [{ type: "text", text: "No saved scenario files." }] };
        }
        const lines = files.map(
          (f) =>
            `  ${f.file} — ${f.url}${f.filter ? ` (filter: ${f.filter})` : ""} — ${f.scenarioCount} scenarios`,
        );
        return {
          content: [
            {
              type: "text",
              text: `Saved scenario files:\n${lines.join("\n")}`,
            },
          ],
        };
      },
    ),
  ];
}
