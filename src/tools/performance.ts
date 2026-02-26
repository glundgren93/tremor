import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { WebVitalsMetrics } from "../core/types";
import { state, type WorkerContext } from "../state";

/** Read Web Vitals metrics from the current page. Returns null if unavailable. */
export async function readMetricsFromPage(ctx?: WorkerContext): Promise<WebVitalsMetrics | null> {
  const page = ctx?.page ?? state.page;
  if (!page) return null;
  try {
    return await page.evaluate(() => {
      // biome-ignore lint/suspicious/noExplicitAny: accessing injected global on window
      const metrics = (window as any).__tremor_metrics;
      return metrics ?? null;
    });
  } catch {
    return null;
  }
}

export function performanceTool(ctx?: WorkerContext) {
  return [
    tool(
      "performance_get_metrics",
      "Get Core Web Vitals (LCP, CLS, TTFB) from the current page. Metrics are automatically collected since browser launch.",
      {},
      async () => {
        const page = ctx?.page ?? state.page;
        if (!page) {
          return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
        }
        const metrics = await readMetricsFromPage(ctx);
        if (!metrics) {
          return {
            content: [
              {
                type: "text",
                text: "No metrics available yet. Navigate to a page and wait for it to load.",
              },
            ],
            isError: true,
          };
        }
        return {
          content: [{ type: "text", text: `Web Vitals:\n${JSON.stringify(metrics, null, 2)}` }],
        };
      },
    ),
  ];
}
