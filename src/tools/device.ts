import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { state, type WorkerContext } from "../state";

const CPU_PROFILES = {
  "no-throttle": { rate: 1, label: "No throttle (normal)" },
  "mid-tier-mobile": { rate: 2, label: "Mid-tier mobile (2x slowdown)" },
  "low-end-mobile": { rate: 4, label: "Low-end mobile (4x slowdown)" },
  "very-slow-device": { rate: 6, label: "Very slow device (6x slowdown)" },
} as const;

export function deviceTools(ctx?: WorkerContext) {
  return [
    tool(
      "device_set_cpu_throttle",
      "Simulate CPU throttling via Chrome DevTools Protocol. Use this to test how the app feels on slower devices.",
      {
        profile: z
          .enum(["no-throttle", "mid-tier-mobile", "low-end-mobile", "very-slow-device"])
          .describe(
            "CPU profile: no-throttle (1x, reset), mid-tier-mobile (2x), low-end-mobile (4x), very-slow-device (6x)",
          ),
      },
      async ({ profile }) => {
        const page = ctx?.page ?? state.page;
        if (!page) {
          return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
        }

        const { rate, label } = CPU_PROFILES[profile];

        if (profile === "no-throttle") {
          if (state.cpuThrottleCdp) {
            try {
              await state.cpuThrottleCdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
              await state.cpuThrottleCdp.detach();
            } catch {}
            state.cpuThrottleCdp = null;
          }
          state.cpuThrottleRate = 1;
          return {
            content: [{ type: "text", text: "CPU throttling disabled — back to normal speed." }],
          };
        }

        if (!state.cpuThrottleCdp) {
          state.cpuThrottleCdp = await page.context().newCDPSession(page);
        }
        await state.cpuThrottleCdp.send("Emulation.setCPUThrottlingRate", { rate });
        state.cpuThrottleRate = rate;

        return {
          content: [{ type: "text", text: `CPU throttling set to ${label}.` }],
        };
      },
    ),
  ];
}
