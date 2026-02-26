import Markdown from "react-markdown";
import type { DashboardFinding } from "./types";

const SEV_DOT: Record<string, string> = {
  critical: "bg-critical",
  major: "bg-major",
  minor: "bg-minor",
  good: "bg-good",
};

const SEV_LABEL: Record<string, string> = {
  critical: "bg-critical/15 text-critical",
  major: "bg-major/15 text-major",
  minor: "bg-minor/15 text-minor",
  good: "bg-good/15 text-good",
};

export function FindingCard({
  finding,
  onClick,
}: {
  finding: DashboardFinding;
  onClick: () => void;
}) {
  return (
    <div
      className="animate-slide-in cursor-pointer rounded-lg border border-border bg-surface p-3 transition-colors hover:border-accent"
      onClick={onClick}
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={`size-2 shrink-0 rounded-full ${SEV_DOT[finding.severity] ?? ""}`}
        />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
          {finding.scenarioName}
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${SEV_LABEL[finding.severity] ?? ""}`}
        >
          {finding.severity}
        </span>
      </div>
      <div className="markdown-body text-xs leading-relaxed text-dim">
        <Markdown>{finding.description}</Markdown>
      </div>
    </div>
  );
}
