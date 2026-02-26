import type { Finding, FindingSeverity } from "../core/types";
import { rateMetrics } from "../core/web-vitals";
import { state } from "../state";
import { findingScreenshots } from "../tools/report";
import type { DashboardFinding, ServerMessage } from "./protocol";

const SEVERITY_WEIGHTS: Record<FindingSeverity, number> = {
  critical: 0,
  major: 30,
  minor: 70,
  good: 100,
};

/** Downgrade severity if metrics contradict the agent's visual assessment */
export function adjustedSeverity(finding: Finding): FindingSeverity {
  if (finding.severity !== "good" || !finding.metrics) return finding.severity;
  const ratings = rateMetrics(finding.metrics);
  const values = Object.values(ratings);
  if (values.includes("poor") || values.includes("needs-improvement")) {
    return "minor";
  }
  return finding.severity;
}

export function calculateScore(findings: Finding[]): number {
  // Exclude document findings from score — they test infrastructure, not the app
  const scorable = findings.filter((f) => f.endpointType !== "document");
  if (scorable.length === 0) return 100;
  const total = scorable.reduce((sum, f) => sum + SEVERITY_WEIGHTS[adjustedSeverity(f)], 0);
  return Math.round(total / scorable.length);
}

export function toDashboardFinding(finding: Finding): DashboardFinding {
  return {
    id: finding.id,
    scenarioName: finding.scenarioName,
    severity: finding.severity,
    description: finding.description,
    screenshot: findingScreenshots.get(finding.id) ?? null,
    endpoint: finding.endpoint,
    category: finding.category,
    metrics: finding.metrics,
    endpointType: finding.endpointType,
    testType: finding.testType,
    recordingPath: finding.recordingPath,
  };
}

export function createFindingTracker(
  emit: (msg: ServerMessage) => void,
  estimatedTotal: number,
): { flush(): void } {
  let lastFindingCount = 0;
  let total = estimatedTotal;

  function flush(): void {
    while (lastFindingCount < state.findings.length) {
      const finding = state.findings[lastFindingCount];
      if (!finding) break;
      lastFindingCount++;

      // Keep total at least as large as the current finding count
      total = Math.max(total, state.findings.length);

      emit({ type: "finding", finding: toDashboardFinding(finding) });
      emit({ type: "progress", current: state.findings.length, total });
      emit({ type: "score", value: calculateScore(state.findings) });
    }
  }

  return { flush };
}
