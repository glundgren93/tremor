import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Finding } from "../core/types";
import { state } from "../state";
import type { CompleteSummary, ServerMessage } from "./protocol";
import { calculateScore, toDashboardFinding } from "./scoring";

export function buildSummary(findings: Finding[], agentRecommendations?: string[]): CompleteSummary {
  const counts = { critical: 0, major: 0, minor: 0, good: 0 };
  for (const f of findings) {
    counts[f.severity]++;
  }

  // Prefer agent-provided recommendations over hardcoded fallbacks
  let recommendations: string[];
  if (agentRecommendations && agentRecommendations.length > 0) {
    recommendations = agentRecommendations;
  } else {
    recommendations = [];
    if (counts.critical > 0) {
      recommendations.push("Add error boundaries to prevent blank pages when API calls fail");
    }
    if (counts.major > 0) {
      recommendations.push("Implement fallback UI for degraded API responses");
    }
    if (counts.minor > 0) {
      recommendations.push(
        'Use structured error components (role="alert") instead of inline error text',
      );
    }
    if (counts.good === findings.length) {
      recommendations.push("Excellent resilience! Consider testing with more edge cases.");
    }
  }

  return {
    score: calculateScore(findings),
    total: findings.length,
    findings: counts,
    recommendations,
  };
}

export function saveReportToDisk(
  url: string,
  summary: CompleteSummary,
  recordings?: Map<string, string>,
): void {
  try {
    const reportsDir = join(homedir(), ".tremor", "reports");
    mkdirSync(reportsDir, { recursive: true });

    const timestamp = Date.now();
    const slug = url
      .replace(/^https?:\/\//, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/-+$/, "")
      .slice(0, 60);

    const findings = state.findings.map(toDashboardFinding);

    const report = {
      url,
      timestamp,
      score: summary.score,
      summary,
      findings,
      ...(state.testConfig ? { testConfig: state.testConfig } : {}),
    };

    const filename = `${timestamp}-${slug}.json`;
    writeFileSync(join(reportsDir, filename), JSON.stringify(report));

    // Persist recordings alongside the report
    if (recordings && recordings.size > 0) {
      persistRecordings(reportsDir, `${timestamp}-${slug}`, recordings);
    }
  } catch {
    // Non-critical — don't fail the test if report saving fails
  }
}

/** Copy video recordings from temp dir to persistent storage alongside the report */
function persistRecordings(
  reportsDir: string,
  reportId: string,
  recordings: Map<string, string>,
): void {
  try {
    const recordingsDir = join(reportsDir, "recordings", reportId);
    mkdirSync(recordingsDir, { recursive: true });

    for (const [findingId, srcPath] of recordings) {
      try {
        copyFileSync(srcPath, join(recordingsDir, `finding-${findingId}.webm`));
      } catch {
        // Source file may not exist yet (page still open) — skip it
      }
    }
  } catch {
    // Non-critical
  }
}

export function emitComplete(
  url: string,
  emit: (msg: ServerMessage) => void,
  flushFindings: () => void,
  recordings?: Map<string, string>,
): void {
  flushFindings();

  // Pass stored agent recommendations if available
  const agentRecs = state.recommendations.length > 0 ? state.recommendations : undefined;
  const summary = buildSummary(state.findings, agentRecs);
  saveReportToDisk(url, summary, recordings);

  emit({ type: "status", phase: "complete" });
  emit({ type: "complete", summary });
}
