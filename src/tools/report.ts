import * as fs from "node:fs/promises";
import * as path from "node:path";
import { tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { consolidateFindings } from "../core/consolidation";
import { generateId } from "../core/id";
import type {
  EndpointType,
  Finding,
  FindingSeverity,
  TestType,
  WebVitalsMetrics,
} from "../core/types";
import { rateMetrics } from "../core/web-vitals";
import { adjustedSeverity } from "../dashboard/scoring";
import { state, type WorkerContext } from "../state";
import { readMetricsFromPage } from "./performance";

/** Map of finding ID → base64-encoded JPEG screenshot, populated by report_add_finding */
export const findingScreenshots = new Map<string, string>();

/** Map of finding ID → absolute path to video file in temp recordings dir */
export const findingRecordings = new Map<string, string>();

function generateFallbackRecommendations(findings: Finding[]): string[] {
  const counts: Record<FindingSeverity, number> = { critical: 0, major: 0, minor: 0, good: 0 };
  for (const f of findings) counts[f.severity]++;

  const recs: string[] = [];
  if (counts.critical > 0)
    recs.push("Add error boundaries to prevent blank pages when API calls fail");
  if (counts.major > 0) recs.push("Implement fallback UI for degraded API responses");
  if (counts.minor > 0)
    recs.push('Use structured error components (role="alert") instead of inline error text');
  if (counts.good === findings.length)
    recs.push("Excellent resilience! Consider testing with more edge cases.");
  return recs;
}

export function reportTools(ctx?: WorkerContext) {
  return [
    tool(
      "report_add_finding",
      "Record a resilience test finding with severity assessment. Auto-captures a screenshot if a browser is open.",
      {
        scenarioName: z.string().describe("Name of the scenario that was tested"),
        severity: z
          .enum(["critical", "major", "minor", "good"])
          .describe(
            "Severity: critical (crash/blank), major (broken), minor (cosmetic), good (handled)",
          ),
        description: z.string().describe("What happened when the fault was applied"),
        testType: z
          .enum(["initial-load", "navigation", "exploratory"])
          .optional()
          .default("initial-load")
          .describe("Whether this finding is from initial page load, navigation flow, or exploratory user-journey testing"),
      },
      async ({ scenarioName, severity, description, testType }) => {
        const id = generateId();

        // Strip markdown bold markers (**) from agent-provided scenarioName
        const cleanScenarioName = scenarioName.replace(/\*\*/g, "").trim();

        const activeFaults = ctx?.activeFaults ?? state.activeFaults;
        const rawEndpoint =
          activeFaults.length > 0 ? activeFaults.map((f) => f.endpoint).join("; ") : "unknown";
        // Clean glob ** from endpoint display (e.g. "* **/api/foo" → "*/api/foo")
        const endpoint = rawEndpoint.replace(/\*\*/g, "*");
        const category =
          activeFaults.length > 0
            ? [...new Set(activeFaults.map((f) => f.category))].join("; ")
            : "unknown";

        // Read endpointType from active faults, default to "api"
        const endpointType: EndpointType =
          activeFaults.length > 0
            ? (activeFaults.find((f) => f.endpointType)?.endpointType ?? "api")
            : "api";

        const page = ctx?.page ?? state.page;
        let screenshotPath: string | null = null;
        let recordingPath: string | null = null;
        if (page) {
          try {
            const buf = await page.screenshot({ type: "jpeg", quality: 70 });
            screenshotPath = `screenshots/finding-${id}.jpg`;
            findingScreenshots.set(id, buf.toString("base64"));
          } catch {}
          try {
            const videoPath = await page.video()?.path();
            if (videoPath) {
              recordingPath = `recordings/finding-${id}.webm`;
              findingRecordings.set(id, videoPath);
            }
          } catch {}
        }

        let metrics: WebVitalsMetrics | null = null;
        try {
          metrics = await readMetricsFromPage(ctx);
        } catch {}

        const finding: Finding = {
          id,
          scenarioName: cleanScenarioName,
          severity,
          description,
          screenshotPath,
          recordingPath,
          endpoint,
          category,
          metrics,
          timestamp: Date.now(),
          endpointType,
          testType: testType as TestType,
        };
        state.findings.push(finding);

        return {
          content: [
            {
              type: "text",
              text: `Finding recorded: [${severity.toUpperCase()}] ${cleanScenarioName}${screenshotPath ? " (screenshot captured)" : ""}`,
            },
          ],
        };
      },
    ),

    tool(
      "report_add_recommendations",
      "Store agent-generated recommendations for the final report. Call this after analyzing all findings.",
      {
        recommendations: z
          .array(z.string())
          .describe(
            "3-5 specific, actionable recommendations referencing actual failures observed",
          ),
      },
      async ({ recommendations }) => {
        state.recommendations = recommendations;
        return {
          content: [
            {
              type: "text",
              text: `Stored ${recommendations.length} recommendations for the report.`,
            },
          ],
        };
      },
    ),

    tool(
      "report_export",
      "Export all recorded findings as a markdown report with screenshots. Creates report.md and screenshots/ in the output directory.",
      {
        outputPath: z
          .string()
          .default("./tremor-report")
          .describe("Directory to write the report to (default: ./tremor-report)"),
        title: z.string().default("Resilience Test Report").describe("Report title"),
        targetUrl: z.string().optional().describe("URL of the application that was tested"),
        recommendations: z
          .array(z.string())
          .optional()
          .describe(
            "Agent-generated recommendations. Falls back to hardcoded logic if not provided.",
          ),
      },
      async ({ outputPath, title, targetUrl, recommendations }) => {
        const SEV_ORDER: Record<string, number> = { critical: 0, major: 1, minor: 2, good: 3 };
        const findings = [...state.findings].sort(
          (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9),
        );
        if (findings.length === 0) {
          return {
            content: [{ type: "text", text: "No findings to export." }],
          };
        }

        // Compute score excluding document findings
        const SEVERITY_WEIGHTS: Record<FindingSeverity, number> = {
          critical: 0,
          major: 30,
          minor: 70,
          good: 100,
        };
        const scorableFindings = findings.filter((f) => f.endpointType !== "document");
        const score =
          scorableFindings.length > 0
            ? Math.round(
                scorableFindings.reduce(
                  (sum, f) => sum + SEVERITY_WEIGHTS[adjustedSeverity(f)],
                  0,
                ) / scorableFindings.length,
              )
            : 100;
        const counts: Record<FindingSeverity, number> = {
          critical: 0,
          major: 0,
          minor: 0,
          good: 0,
        };
        for (const f of findings) counts[f.severity]++;

        // Write screenshots
        const screenshotDir = path.join(outputPath, "screenshots");
        await fs.mkdir(screenshotDir, { recursive: true });

        for (const f of findings) {
          const b64 = findingScreenshots.get(f.id);
          if (b64) {
            await fs.writeFile(
              path.join(screenshotDir, `finding-${f.id}.jpg`),
              Buffer.from(b64, "base64"),
            );
          }
        }

        // Write recordings
        const hasRecordings = findings.some((f) => findingRecordings.has(f.id));
        if (hasRecordings) {
          const recordingDir = path.join(outputPath, "recordings");
          await fs.mkdir(recordingDir, { recursive: true });

          for (const f of findings) {
            const srcPath = findingRecordings.get(f.id);
            if (srcPath) {
              try {
                await fs.copyFile(srcPath, path.join(recordingDir, `finding-${f.id}.webm`));
              } catch {}
            }
          }
        }

        // Consolidate findings
        const { groups, ungrouped } = consolidateFindings(findings);

        // Split by test type
        const initialLoadFindings = findings.filter((f) => f.testType === "initial-load" || !f.testType);
        const navigationFindings = findings.filter((f) => f.testType === "navigation");
        const exploratoryFindings = findings.filter((f) => f.testType === "exploratory");

        // Generate markdown
        const date = new Date().toISOString().split("T")[0];
        const lines: string[] = [
          `# ${title}`,
          "",
          ...(targetUrl ? [`**Target:** ${targetUrl}`, ""] : []),
          `**Date:** ${date}  `,
          `**Resilience Score:** ${score}%`,
          "",
          "## Summary",
          "",
          "| Severity | Count |",
          "|----------|-------|",
          `| Critical | ${counts.critical} |`,
          `| Major | ${counts.major} |`,
          `| Minor | ${counts.minor} |`,
          `| Good | ${counts.good} |`,
          "",
          `**Findings:** ${groups.length + ungrouped.length} (consolidated) | **Endpoints Tested:** ${findings.length}`,
          "",
        ];

        // Recommendations: prefer agent-provided, then stored, then fallback
        const recs =
          recommendations ??
          (state.recommendations.length > 0
            ? state.recommendations
            : generateFallbackRecommendations(findings));
        if (recs.length > 0) {
          lines.push("## Recommendations");
          lines.push("");
          for (const r of recs) lines.push(`- ${r}`);
          lines.push("");
        }

        // Render findings helper
        const renderFinding = (f: Finding) => {
          const typeBadge =
            f.endpointType === "document" ? " | **Type:** document" : " | **Type:** api";
          const docNote =
            f.endpointType === "document" ? " *(infrastructure — not counted in score)*" : "";
          const safeEndpoint = f.endpoint.includes("*") ? `\`${f.endpoint}\`` : f.endpoint;

          lines.push(`### ${f.scenarioName}${docNote}`);
          lines.push("");
          lines.push(
            `**Severity:** ${f.severity} | **Endpoint:** ${safeEndpoint} | **Category:** ${f.category}${typeBadge}`,
          );
          lines.push("");
          lines.push(f.description);
          lines.push("");
          if (f.metrics) {
            const ratings = rateMetrics(f.metrics);
            const parts: string[] = [];
            if (f.metrics.lcp != null)
              parts.push(
                `LCP: ${Math.round(f.metrics.lcp)}ms${ratings.lcp ? ` **(${ratings.lcp.toUpperCase()})**` : ""}`,
              );
            if (f.metrics.cls != null)
              parts.push(
                `CLS: ${f.metrics.cls.toFixed(3)}${ratings.cls ? ` **(${ratings.cls.toUpperCase()})**` : ""}`,
              );
            if (f.metrics.ttfb != null)
              parts.push(
                `TTFB: ${Math.round(f.metrics.ttfb)}ms${ratings.ttfb ? ` **(${ratings.ttfb.toUpperCase()})**` : ""}`,
              );
            if (f.metrics.inp != null)
              parts.push(
                `INP: ${Math.round(f.metrics.inp)}ms${ratings.inp ? ` **(${ratings.inp.toUpperCase()})**` : ""}`,
              );
            if (parts.length > 0) {
              lines.push(`**Metrics:** ${parts.join(" | ")}`);
              lines.push("");
            }
          }
          if (findingScreenshots.has(f.id)) {
            lines.push(`![Screenshot](screenshots/finding-${f.id}.jpg)`);
            lines.push("");
          }
          if (findingRecordings.has(f.id)) {
            lines.push(`[View recording](recordings/finding-${f.id}.webm)`);
            lines.push("");
          }
          lines.push("---");
          lines.push("");
        };

        const renderConsolidatedGroup = (group: (typeof groups)[0]) => {
          const f = group.representative;
          const docNote =
            f.endpointType === "document" ? " *(infrastructure — not counted in score)*" : "";

          lines.push(
            `### ${group.label} endpoints (${group.count} tested) — ${f.severity}${docNote}`,
          );
          lines.push("");
          lines.push(
            `**Severity:** ${f.severity} | **Category:** ${f.category} | **Type:** ${f.endpointType}`,
          );
          lines.push("");
          lines.push(f.description);
          lines.push("");
          if (findingScreenshots.has(f.id)) {
            lines.push(`![Screenshot](screenshots/finding-${f.id}.jpg)`);
            lines.push("");
          }
          if (findingRecordings.has(f.id)) {
            lines.push(`[View recording](recordings/finding-${f.id}.webm)`);
            lines.push("");
          }
          lines.push("<details>");
          lines.push(`<summary>All ${group.count} endpoints</summary>`);
          lines.push("");
          for (const member of group.members) {
            lines.push(`- ${member.endpoint}: ${member.scenarioName}`);
          }
          lines.push("");
          lines.push("</details>");
          lines.push("");
          lines.push("---");
          lines.push("");
        };

        // Render initial load findings
        const hasMultipleSections = navigationFindings.length > 0 || exploratoryFindings.length > 0;
        const initialGroups = groups.filter((g) => g.representative.testType === "initial-load" || !g.representative.testType);
        const initialUngrouped = ungrouped.filter((f) => f.testType === "initial-load" || !f.testType);

        if (hasMultipleSections) {
          lines.push("## Initial Load Findings");
          lines.push("");
        } else {
          lines.push("## Findings");
          lines.push("");
        }

        for (const group of initialGroups) renderConsolidatedGroup(group);
        for (const f of initialUngrouped) renderFinding(f);

        // Render navigation findings if any
        if (navigationFindings.length > 0) {
          const navGroups = groups.filter((g) => g.representative.testType === "navigation");
          const navUngrouped = ungrouped.filter((f) => f.testType === "navigation");

          lines.push("## Navigation Flow Findings");
          lines.push("");

          for (const group of navGroups) renderConsolidatedGroup(group);
          for (const f of navUngrouped) renderFinding(f);
        }

        // Render exploratory findings if any
        if (exploratoryFindings.length > 0) {
          const expGroups = groups.filter((g) => g.representative.testType === "exploratory");
          const expUngrouped = ungrouped.filter((f) => f.testType === "exploratory");

          lines.push("## Exploratory Findings");
          lines.push("");

          for (const group of expGroups) renderConsolidatedGroup(group);
          for (const f of expUngrouped) renderFinding(f);
        }

        const reportPath = path.join(outputPath, "report.md");
        await fs.writeFile(reportPath, lines.join("\n"));

        return {
          content: [
            {
              type: "text",
              text: `Report exported to ${reportPath} with ${findings.length} findings and screenshots/ directory.`,
            },
          ],
        };
      },
    ),
  ];
}
