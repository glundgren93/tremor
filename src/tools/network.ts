import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { redactUrl } from "../core/redaction";
import { state, type WorkerContext } from "../state";

export function networkTools(ctx?: WorkerContext) {
  return [
    tool(
      "network_get_requests",
      "Get captured network requests with optional filtering",
      {
        filter: z
          .object({
            url: z.string().optional().describe("URL substring to filter by"),
            method: z.string().optional().describe("HTTP method to filter by"),
            status: z.number().optional().describe("Response status code to filter by"),
          })
          .optional()
          .describe("Optional filters"),
      },
      async ({ filter }) => {
        let requests = state.capturedRequests;
        if (filter) {
          if (filter.url) {
            const urlFilter = filter.url;
            requests = requests.filter((r) => r.url.includes(urlFilter));
          }
          if (filter.method) {
            const methodFilter = filter.method.toUpperCase();
            requests = requests.filter((r) => r.method === methodFilter);
          }
          if (filter.status) {
            const statusFilter = filter.status;
            requests = requests.filter((r) => r.response.status === statusFilter);
          }
        }
        const summary = requests.map((r) => ({
          id: r.id,
          method: r.method,
          url: redactUrl(r.url, state.redactionConfig),
          status: r.response.status,
          duration: r.response.duration,
          bodyLength: r.response.body.length,
          timestamp: r.timestamp,
        }));
        return {
          content: [
            {
              type: "text",
              text: `${summary.length} requests captured:\n${JSON.stringify(summary, null, 2)}`,
            },
          ],
        };
      },
    ),

    tool(
      "network_wait_idle",
      "Wait until no network requests have been made for 2 seconds",
      {
        timeout: z
          .number()
          .optional()
          .default(10000)
          .describe("Maximum time to wait in ms (default 10000)"),
      },
      async ({ timeout }) => {
        const page = ctx?.page ?? state.page;
        if (!page) {
          return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
        }
        const start = Date.now();
        let lastCount = state.capturedRequests.length;
        let idleStart = Date.now();
        while (Date.now() - start < timeout) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          const currentCount = state.capturedRequests.length;
          if (currentCount !== lastCount) {
            lastCount = currentCount;
            idleStart = Date.now();
          }
          if (Date.now() - idleStart >= 2000) {
            return {
              content: [
                {
                  type: "text",
                  text: `Network idle after ${Date.now() - start}ms. ${lastCount} total requests captured.`,
                },
              ],
            };
          }
        }
        return {
          content: [
            {
              type: "text",
              text: `Timeout after ${timeout}ms. Network may still be active. ${lastCount} requests captured.`,
            },
          ],
        };
      },
    ),

    tool("network_clear", "Clear all captured network requests", {}, async () => {
      const count = state.capturedRequests.length;
      state.capturedRequests = [];
      return { content: [{ type: "text", text: `Cleared ${count} captured requests.` }] };
    }),
  ];
}
