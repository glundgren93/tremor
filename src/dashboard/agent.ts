import type { query as queryType } from "@anthropic-ai/claude-agent-sdk";
import type { WorkerContext } from "../state";
import { buildSystemPrompt } from "./prompt";
import type { ServerMessage } from "./protocol";
import { createTremorServer, TREMOR_TOOL_NAMES } from "./tool-bridge";

export interface AgentLoopOptions {
  url: string;
  presets: string[];
  scenarioNames: string[];
  emit: (msg: ServerMessage) => void;
  stopped: () => boolean;
  onFindingAdded: () => void;
  ctx?: WorkerContext;
  workerId?: number;
  exploratory?: boolean;
  cpuThrottleRate?: number;
}

function buildUserPrompt(url: string, scenarioNames: string[], presets: string[], exploratory?: boolean): string {
  const parts = [`Test the resilience of the web app at ${url}. The browser is already open and navigated to that URL. Network traffic has been captured.`];

  if (scenarioNames.length > 0) {
    const list = scenarioNames.map((n, i) => `${i + 1}. ${n}`).join("\n");
    parts.push(`The following ${scenarioNames.length} scenarios have been selected for testing:\n${list}`);
  }

  if (presets.length > 0) {
    parts.push(`Also test these presets: ${presets.join(", ")}`);
  }

  if (scenarioNames.length === 0 && presets.length === 0 && exploratory) {
    parts.push("This is an exploratory-only run. No curated scenarios or presets were selected. Skip straight to the Exploratory User-Journey Testing section — use the app as a real user would while applying faults, and discover resilience issues through interaction.");
    parts.push("Begin exploratory testing now.");
  } else {
    parts.push("Begin testing now. Use fault_apply with each scenario name.");
  }

  return parts.join("\n\n");
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<void> {
  const { url, presets, scenarioNames, emit, stopped, onFindingAdded, ctx, workerId, exploratory, cpuThrottleRate } = options;

  emit({ type: "status", phase: "testing" });

  // Dynamic import to avoid bundling issues — the SDK is external
  const { query } = (await import("@anthropic-ai/claude-agent-sdk")) as {
    query: typeof queryType;
  };

  const tremorServer = createTremorServer(ctx);

  const q = query({
    prompt: buildUserPrompt(url, scenarioNames, presets, exploratory),
    options: {
      mcpServers: { tremor: tremorServer },
      allowedTools: TREMOR_TOOL_NAMES,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      model: process.env.TREMOR_MODEL || "claude-haiku-4-5-20251001",
      maxTurns: 80,
      systemPrompt: buildSystemPrompt(presets, { exploratory, cpuThrottleRate, scenarioCount: scenarioNames.length }),
    },
  });

  try {
    for await (const message of q) {
      if (stopped()) {
        try { q.close(); } catch {}
        break;
      }
      handleMessage(message, emit, onFindingAdded, workerId);
    }
  } catch (err) {
    // Ignore ProcessTransport errors during shutdown — the SDK may try to
    // write after the subprocess has exited when a test is stopped mid-run.
    const msg = err instanceof Error ? err.message : "";
    if (!msg.includes("ProcessTransport")) {
      throw err;
    }
  }
}

function handleMessage(
  // biome-ignore lint/suspicious/noExplicitAny: SDK message types are complex union
  message: any,
  emit: (msg: ServerMessage) => void,
  onFindingAdded: () => void,
  workerId?: number,
): void {
  if (message.type === "assistant") {
    const content = message.message?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === "text" && block.text) {
        emit({ type: "agent_thinking", text: block.text, workerId });
      }
      if (block.type === "tool_use") {
        emit({
          type: "tool_call",
          tool: block.name,
          args: (block.input as Record<string, unknown>) ?? {},
          workerId,
        });

        if (
          block.name === "mcp__tremor__report_add_finding" ||
          block.name === "report_add_finding"
        ) {
          setTimeout(() => onFindingAdded(), 500);
        }
      }
    }
  }
}
