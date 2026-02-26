import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { WorkerContext } from "../state";
import { browserTools } from "../tools/browser";
import { deviceTools } from "../tools/device";
import { faultTools } from "../tools/fault/tools";
import { networkTools } from "../tools/network";
import { performanceTool } from "../tools/performance";
import { reportTools } from "../tools/report";

/** Tool names as they appear when prefixed with the server name (mcp__tremor__*) */
export const TREMOR_TOOL_NAMES = [
  "mcp__tremor__browser_navigate",
  "mcp__tremor__browser_click",
  "mcp__tremor__browser_type",
  "mcp__tremor__browser_screenshot",
  "mcp__tremor__network_get_requests",
  "mcp__tremor__network_wait_idle",
  "mcp__tremor__network_clear",
  "mcp__tremor__fault_generate_scenarios",
  "mcp__tremor__fault_apply",
  "mcp__tremor__fault_apply_preset",
  "mcp__tremor__fault_apply_custom",
  "mcp__tremor__fault_reset",
  "mcp__tremor__fault_list",
  "mcp__tremor__fault_remove",
  "mcp__tremor__performance_get_metrics",
  "mcp__tremor__report_add_finding",
  "mcp__tremor__report_add_recommendations",
  "mcp__tremor__report_export",
  "mcp__tremor__scenarios_save",
  "mcp__tremor__scenarios_load",
  "mcp__tremor__scenarios_list_files",
  "mcp__tremor__device_set_cpu_throttle",
];

export function createTremorServer(ctx?: WorkerContext) {
  return createSdkMcpServer({
    name: "tremor",
    version: "0.3.0",
    tools: [
      ...browserTools(ctx),
      ...networkTools(ctx),
      ...faultTools(ctx),
      ...deviceTools(ctx),
      ...performanceTool(ctx),
      ...reportTools(ctx),
    ],
  });
}
