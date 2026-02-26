import type { CompleteSummary } from "./types";

const BREAKDOWN = [
  { key: "critical" as const, label: "Critical", dot: "bg-critical" },
  { key: "major" as const, label: "Major", dot: "bg-major" },
  { key: "minor" as const, label: "Minor", dot: "bg-minor" },
  { key: "good" as const, label: "Good", dot: "bg-good" },
];

export function CompleteOverlay({
  summary,
  visible,
  onRestart,
  onViewReport,
  onPreviewReport,
}: {
  summary: CompleteSummary | null;
  visible: boolean;
  onRestart: () => void;
  onViewReport: () => void;
  onPreviewReport: () => void;
}) {
  if (!visible || !summary) return null;

  const scoreColor =
    summary.score >= 80
      ? "text-good"
      : summary.score >= 50
        ? "text-minor"
        : "text-critical";

  return (
    <div className="fixed inset-0 z-100 flex items-center justify-center bg-[rgba(10,10,15,0.85)]">
      <div className="max-h-[90vh] w-[90%] max-w-[640px] overflow-y-auto rounded-2xl border border-border bg-surface p-8 text-center">
        <h2 className="mb-2 text-[22px] font-semibold">Test Complete</h2>
        <div className={`my-4 text-[64px] font-extrabold ${scoreColor}`}>
          {summary.score}%
        </div>
        <p className="text-sm text-dim">Resilience Score</p>

        {/* Breakdown */}
        <div className="my-4 flex flex-wrap justify-center gap-4">
          {BREAKDOWN.map((b) => (
            <div key={b.key} className="flex items-center gap-1.5 text-sm">
              <span className={`size-2 rounded-full ${b.dot}`} />
              {summary.findings[b.key]} {b.label}
            </div>
          ))}
        </div>

        {/* Recommendations */}
        {summary.recommendations.length > 0 && (
          <div className="mt-5 border-t border-border pt-4 text-left">
            <h3 className="mb-2.5 text-sm text-dim">Recommendations</h3>
            <ul className="list-none">
              {summary.recommendations.map((r, i) => (
                <li
                  key={i}
                  className="relative mb-1.5 pl-4 text-[13px] leading-relaxed text-text before:absolute before:left-0 before:top-[7px] before:size-1.5 before:rounded-full before:bg-accent"
                >
                  {r}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Actions */}
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            className="cursor-pointer rounded-lg border border-border bg-transparent px-6 py-3 text-[15px] font-semibold text-text transition-colors hover:border-accent"
            onClick={onViewReport}
          >
            View Full Report
          </button>
          <button
            className="cursor-pointer rounded-lg border border-border bg-transparent px-6 py-3 text-[15px] font-semibold text-text transition-colors hover:border-accent"
            onClick={onPreviewReport}
          >
            Preview Report
          </button>
          <button
            className="cursor-pointer rounded-lg border-none bg-accent px-6 py-3 text-[15px] font-semibold text-white transition-opacity hover:opacity-85"
            onClick={onRestart}
          >
            Test Another URL
          </button>
        </div>
      </div>
    </div>
  );
}
