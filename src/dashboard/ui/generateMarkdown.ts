import type { DashboardFinding, Report } from "./types";

type ConsolidatedGroup = {
  representative: DashboardFinding;
  members: DashboardFinding[];
  label: string;
  count: number;
};

function extractSignatureWords(description: string): Set<string> {
  const cleaned = description
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b\d+\b/g, "")
    .replace(/[^a-zA-Z\s]/g, " ")
    .toLowerCase();
  return new Set(cleaned.split(/\s+/).filter((w) => w.length > 2));
}

function wordOverlap(a: string, b: string): number {
  const wordsA = extractSignatureWords(a);
  const wordsB = extractSignatureWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let shared = 0;
  for (const w of wordsA) if (wordsB.has(w)) shared++;
  return shared / Math.max(wordsA.size, wordsB.size);
}

function findCommonPathPrefix(endpoints: string[]): string {
  if (endpoints.length === 0) return "";
  if (endpoints.length === 1) return endpoints[0]!;
  const paths = endpoints.map((ep) => {
    const withoutMethod = ep.replace(/^[A-Z]+\s+/, "");
    try { return new URL(withoutMethod).pathname; } catch { return withoutMethod; }
  });
  const segments0 = paths[0]!.split("/");
  let commonLength = 0;
  for (let i = 0; i < segments0.length; i++) {
    if (paths.every((p) => p.split("/")[i] === segments0[i])) commonLength = i + 1;
    else break;
  }
  const prefix = segments0.slice(0, commonLength).join("/");
  return prefix ? `${prefix}/*` : endpoints[0]!;
}

function consolidateDashboardFindings(findings: DashboardFinding[]): { groups: ConsolidatedGroup[]; ungrouped: DashboardFinding[] } {
  const buckets = new Map<string, DashboardFinding[]>();
  for (const f of findings) {
    const key = `${f.severity}|${f.category}|${f.endpointType ?? "api"}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(f);
    else buckets.set(key, [f]);
  }

  const groups: ConsolidatedGroup[] = [];
  const ungrouped: DashboardFinding[] = [];

  for (const bucket of buckets.values()) {
    const clusters: DashboardFinding[][] = [];
    for (const finding of bucket) {
      let placed = false;
      for (const cluster of clusters) {
        if (wordOverlap(cluster[0]!.description, finding.description) > 0.6) {
          cluster.push(finding);
          placed = true;
          break;
        }
      }
      if (!placed) clusters.push([finding]);
    }
    for (const cluster of clusters) {
      if (cluster.length >= 3) {
        groups.push({
          representative: cluster[0]!,
          members: cluster,
          label: findCommonPathPrefix(cluster.map((f) => f.endpoint)),
          count: cluster.length,
        });
      } else {
        ungrouped.push(...cluster);
      }
    }
  }

  return { groups, ungrouped };
}

export function generateMarkdown(report: Report): string {
  const SEV_ORDER: Record<string, number> = { critical: 0, major: 1, minor: 2, good: 3 };
  const findings = [...(report.findings || [])].sort(
    (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9),
  );

  let score: number;
  if (report.score != null) {
    score = report.score;
  } else if (report.summary?.score != null) {
    score = report.summary.score;
  } else {
    const SEVERITY_WEIGHTS = { critical: 0, major: 30, minor: 70, good: 100 };
    // Exclude document findings from score
    const scorable = findings.filter((f) => f.endpointType !== "document");
    score =
      scorable.length === 0
        ? 100
        : Math.round(
            scorable.reduce(
              (sum, f) =>
                sum +
                (SEVERITY_WEIGHTS[f.severity as keyof typeof SEVERITY_WEIGHTS] ||
                  0),
              0,
            ) / scorable.length,
          );
  }

  let counts: { critical: number; major: number; minor: number; good: number };
  if (report.summary?.findings) {
    counts = report.summary.findings;
  } else {
    counts = { critical: 0, major: 0, minor: 0, good: 0 };
    for (const f of findings) {
      const sev = f.severity as keyof typeof counts;
      counts[sev] = (counts[sev] || 0) + 1;
    }
  }

  const date = new Date(report.timestamp).toISOString().split("T")[0];
  const lines: string[] = [
    "# Resilience Test Report",
    "",
    ...(report.url ? [`**Target:** ${report.url}`, ""] : []),
    `**Date:** ${date}  `,
    `**Resilience Score:** ${score}%`,
    "",
    "## Summary",
    "",
    "| Severity | Count |",
    "|----------|-------|",
    `| Critical | ${counts.critical || 0} |`,
    `| Major | ${counts.major || 0} |`,
    `| Minor | ${counts.minor || 0} |`,
    `| Good | ${counts.good || 0} |`,
    "",
  ];

  const recs = report.summary?.recommendations || [];
  if (recs.length > 0) {
    lines.push("## Recommendations", "");
    for (const r of recs) {
      lines.push(`- ${r}`);
    }
    lines.push("");
  }

  // Consolidate findings
  const { groups, ungrouped } = consolidateDashboardFindings(findings);

  const hasNavigation = findings.some((f) => f.testType === "navigation");
  const initialFindings = findings.filter((f) => f.testType !== "navigation");
  const navigationFindings = findings.filter((f) => f.testType === "navigation");

  const renderFinding = (f: DashboardFinding) => {
    const typeBadge = f.endpointType === "document" ? " | **Type:** document" : " | **Type:** api";
    const docNote = f.endpointType === "document" ? " *(infrastructure — not counted in score)*" : "";
    const endpoint = f.endpoint || "unknown";
    const safeEndpoint = endpoint.includes("*") ? `\`${endpoint}\`` : endpoint;
    lines.push(`### ${f.scenarioName}${docNote}`, "");
    lines.push(
      `**Severity:** ${f.severity} | **Endpoint:** ${safeEndpoint} | **Category:** ${f.category || "unknown"}${typeBadge}`,
      "",
    );
    lines.push(f.description, "");
    if (f.metrics) {
      const parts: string[] = [];
      if (f.metrics.lcp != null) parts.push(`LCP: ${Math.round(f.metrics.lcp)}ms`);
      if (f.metrics.cls != null) parts.push(`CLS: ${f.metrics.cls.toFixed(3)}`);
      if (f.metrics.ttfb != null) parts.push(`TTFB: ${Math.round(f.metrics.ttfb)}ms`);
      if (parts.length > 0) {
        lines.push(`**Metrics:** ${parts.join(" | ")}`, "");
      }
    }
    if (f.screenshot) {
      lines.push(`![Screenshot](data:image/jpeg;base64,${f.screenshot})`, "");
    }
    lines.push("---", "");
  };

  const renderGroup = (group: ConsolidatedGroup) => {
    const f = group.representative;
    const docNote = f.endpointType === "document" ? " *(infrastructure — not counted in score)*" : "";
    lines.push(`### ${group.label} endpoints (${group.count} tested) — ${f.severity}${docNote}`, "");
    lines.push(
      `**Severity:** ${f.severity} | **Category:** ${f.category || "unknown"} | **Type:** ${f.endpointType ?? "api"}`,
      "",
    );
    lines.push(f.description, "");
    if (f.screenshot) {
      lines.push(`![Screenshot](data:image/jpeg;base64,${f.screenshot})`, "");
    }
    lines.push("<details>");
    lines.push(`<summary>All ${group.count} endpoints</summary>`, "");
    for (const member of group.members) {
      lines.push(`- ${member.endpoint}: ${member.scenarioName}`);
    }
    lines.push("", "</details>", "");
    lines.push("---", "");
  };

  // Render initial load findings
  const initialGroups = groups.filter((g) => g.representative.testType !== "navigation");
  const initialUngrouped = ungrouped.filter((f) => f.testType !== "navigation");

  if (hasNavigation) {
    lines.push("## Initial Load Findings", "");
  } else {
    lines.push("## Findings", "");
  }

  if (initialGroups.length === 0 && initialUngrouped.length === 0 && !hasNavigation) {
    lines.push("No findings recorded.", "");
  }

  for (const group of initialGroups) renderGroup(group);
  for (const f of initialUngrouped) renderFinding(f);

  // Render navigation findings if any
  if (hasNavigation) {
    const navGroups = groups.filter((g) => g.representative.testType === "navigation");
    const navUngrouped = ungrouped.filter((f) => f.testType === "navigation");

    lines.push("## Navigation Flow Findings", "");
    for (const group of navGroups) renderGroup(group);
    for (const f of navUngrouped) renderFinding(f);
  }

  return lines.join("\n");
}

export function downloadMarkdown(report: Report): void {
  const md = generateMarkdown(report);
  const blob = new Blob([md], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const slug = (report.url || "report")
    .replace(/https?:\/\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/-+$/, "");
  const a = document.createElement("a");
  a.href = url;
  a.download = `tremor-${slug}.md`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
