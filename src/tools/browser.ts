import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { clearDiagnostics, readDiagnostics } from "../core/page-diagnostics";
import { type MetricRatings, rateMetrics } from "../core/web-vitals";
import { state, type WorkerContext } from "../state";
import { readMetricsFromPage } from "./performance";

export function browserTools(ctx?: WorkerContext) {
  return [
    tool(
      "browser_navigate",
      "Navigate to a URL in the current browser",
      { url: z.string().url().describe("URL to navigate to") },
      async ({ url }) => {
        const page = ctx?.page ?? state.page;
        if (!page) {
          return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
        }
        clearDiagnostics(page);
        await page.goto(url, { waitUntil: "networkidle" });
        const title = await page.title();
        return { content: [{ type: "text", text: `Navigated to "${title}"` }] };
      },
    ),

    tool(
      "browser_click",
      "Click an element on the page",
      { selector: z.string().describe("CSS selector of element to click") },
      async ({ selector }) => {
        const page = ctx?.page ?? state.page;
        if (!page) {
          return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
        }
        await page.click(selector);
        return { content: [{ type: "text", text: `Clicked "${selector}"` }] };
      },
    ),

    tool(
      "browser_type",
      "Type text into an input element",
      {
        selector: z.string().describe("CSS selector of input element"),
        text: z.string().describe("Text to type"),
      },
      async ({ selector, text }) => {
        const page = ctx?.page ?? state.page;
        if (!page) {
          return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
        }
        await page.fill(selector, text);
        return { content: [{ type: "text", text: `Typed into "${selector}"` }] };
      },
    ),

    tool(
      "browser_screenshot",
      "Take a screenshot of the current page",
      {
        fullPage: z.boolean().optional().default(false).describe("Capture full page"),
      },
      async ({ fullPage }) => {
        const page = ctx?.page ?? state.page;
        if (!page) {
          return { content: [{ type: "text", text: "Error: No browser open." }], isError: true };
        }
        const buffer = await page.screenshot({
          fullPage,
          type: "jpeg",
          quality: 80,
        });

        // Build diagnostic summary
        const diag = readDiagnostics(page);
        const metrics = await readMetricsFromPage(ctx);
        const diagnosticLines: string[] = ["--- Page Diagnostics ---"];

        // Console errors
        if (diag.consoleErrors.length > 0) {
          diagnosticLines.push(`Console Errors (${diag.consoleErrors.length}):`);
          for (const err of diag.consoleErrors.slice(0, 10)) {
            diagnosticLines.push(`  - ${err}`);
          }
          if (diag.consoleErrors.length > 10) {
            diagnosticLines.push(`  ... and ${diag.consoleErrors.length - 10} more`);
          }
        } else {
          diagnosticLines.push("Console Errors: none");
        }

        // Failed requests
        if (diag.failedRequests.length > 0) {
          diagnosticLines.push(`Failed Requests (${diag.failedRequests.length}):`);
          for (const req of diag.failedRequests.slice(0, 10)) {
            diagnosticLines.push(`  - ${req.method} ${req.url} → ${req.status}`);
          }
          if (diag.failedRequests.length > 10) {
            diagnosticLines.push(`  ... and ${diag.failedRequests.length - 10} more`);
          }
        } else {
          diagnosticLines.push("Failed Requests: none");
        }

        // Web Vitals with ratings
        if (metrics) {
          const ratings = rateMetrics(metrics);
          diagnosticLines.push("Web Vitals:");
          diagnosticLines.push(
            `  LCP: ${metrics.lcp !== null ? `${Math.round(metrics.lcp)}ms (${ratingLabel(ratings.lcp)})` : "N/A"}`,
          );
          diagnosticLines.push(
            `  CLS: ${metrics.cls !== null ? `${metrics.cls.toFixed(3)} (${ratingLabel(ratings.cls)})` : "N/A"}`,
          );
          diagnosticLines.push(
            `  TTFB: ${metrics.ttfb !== null ? `${Math.round(metrics.ttfb)}ms (${ratingLabel(ratings.ttfb)})` : "N/A"}`,
          );
          diagnosticLines.push(
            `  INP: ${metrics.inp !== null ? `${Math.round(metrics.inp)}ms (${ratingLabel(ratings.inp)})` : "N/A"}`,
          );
        } else {
          diagnosticLines.push("Web Vitals: not available");
        }

        return {
          content: [
            { type: "image", data: buffer.toString("base64"), mimeType: "image/jpeg" },
            { type: "text", text: diagnosticLines.join("\n") },
          ],
        };
      },
    ),
  ];
}

function ratingLabel(rating: MetricRatings[keyof MetricRatings]): string {
  if (!rating) return "N/A";
  return rating.toUpperCase();
}
