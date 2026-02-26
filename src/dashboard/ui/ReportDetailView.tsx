import { useState } from "react";
import { FindingCard } from "./FindingCard";
import { FindingModal } from "./FindingModal";
import type { DashboardFinding, Report } from "./types";

const SCORE_COLORS: Record<string, string> = {
  high: "bg-good/15 text-good",
  mid: "bg-minor/15 text-minor",
  low: "bg-critical/15 text-critical",
};

function scoreTier(s: number) {
  return s >= 80 ? "high" : s >= 50 ? "mid" : "low";
}

export function ReportDetailView({
  report,
  onBack,
  onPreviewReport,
}: {
  report: Report;
  onBack: () => void;
  onPreviewReport: () => void;
}) {
  const [modalFinding, setModalFinding] = useState<DashboardFinding | null>(null);
  const date = new Date(report.timestamp);
  const tier = scoreTier(report.score);
  const SEV_ORDER: Record<string, number> = { critical: 0, major: 1, minor: 2, good: 3 };
  const findings = [...(report.findings || [])].sort(
    (a, b) => (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9),
  );

  return (
    <div className="min-h-[calc(100vh-65px)] p-6">
      {/* Header */}
      <div className="mb-6 flex flex-wrap items-center gap-4">
        <button
          className="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-1.5 text-xs font-semibold text-text transition-colors hover:border-accent"
          onClick={onBack}
        >
          &larr; Back
        </button>
        <h2 className="min-w-0 flex-1 truncate text-xl font-semibold">
          {report.url}
        </h2>
        <span
          className={`min-w-[48px] rounded-full px-2.5 py-0.5 text-center text-sm font-bold ${SCORE_COLORS[tier]}`}
        >
          {report.score}%
        </span>
        <button
          className="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-1.5 text-xs font-semibold text-text transition-colors hover:border-accent"
          onClick={onPreviewReport}
        >
          Preview Report
        </button>
      </div>

      <div className="mb-4 text-[13px] text-dim">
        Tested on {date.toLocaleDateString()} at {date.toLocaleTimeString()} &bull; {findings.length} findings
      </div>

      {report.testConfig && (
        <div className="mb-4 flex flex-wrap gap-2">
          {report.testConfig.presets.map((p) => (
            <span
              key={p}
              className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-medium text-accent"
            >
              {p}
            </span>
          ))}
          <span className="rounded-full bg-surface px-2.5 py-0.5 text-xs font-medium text-dim">
            {report.testConfig.scenarioCount} scenario{report.testConfig.scenarioCount !== 1 ? "s" : ""}
          </span>
          <span className="rounded-full bg-surface px-2.5 py-0.5 text-xs font-medium text-dim">
            {report.testConfig.exploratory ? "exploratory" : "curated"}
          </span>
          {report.testConfig.cpuProfile && (
            <span className="rounded-full bg-minor/10 px-2.5 py-0.5 text-xs font-medium text-minor">
              {report.testConfig.cpuProfile}
            </span>
          )}
        </div>
      )}

      {/* Findings grid */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(340px,1fr))] gap-3">
        {findings.map((f) => (
          <FindingCard
            key={f.id}
            finding={f}
            onClick={() => setModalFinding(f)}
          />
        ))}
      </div>

      <FindingModal finding={modalFinding} onClose={() => setModalFinding(null)} />
    </div>
  );
}
