import { useCallback, useEffect, useRef, useState } from "react";
import type { Report, ReportListItem, ScenarioFileItem } from "./types";

const SCORE_BG: Record<string, string> = {
  high: "bg-good/15 text-good",
  mid: "bg-minor/15 text-minor",
  low: "bg-critical/15 text-critical",
};

function scoreTier(s: number) {
  return s >= 80 ? "high" : s >= 50 ? "mid" : "low";
}

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

export function IdleView({
  onStartTest,
  onPreviewProfile,
  onShowReport,
}: {
  onStartTest: (url: string, requiresAuth: boolean) => void;
  onPreviewProfile: (profile: ScenarioFileItem) => void;
  onShowReport: (report: Report) => void;
}) {
  const [reports, setReports] = useState<ReportListItem[]>([]);
  const [profiles, setProfiles] = useState<ScenarioFileItem[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const authRef = useRef<HTMLInputElement>(null);

  const loadReports = useCallback(async () => {
    try {
      const res = await fetch("/api/reports");
      const data: ReportListItem[] = await res.json();
      setReports(data);
    } catch {
      setReports([]);
    }
  }, []);

  const loadProfiles = useCallback(async () => {
    try {
      const res = await fetch("/api/scenarios");
      const data: ScenarioFileItem[] = await res.json();
      setProfiles(data);
    } catch {
      setProfiles([]);
    }
  }, []);

  useEffect(() => {
    loadReports();
    loadProfiles();
  }, [loadReports, loadProfiles]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const url = inputRef.current?.value.trim();
    if (!url) return;
    setSubmitting(true);
    onStartTest(url, authRef.current?.checked ?? false);
  };

  const handleDeleteProfile = async (file: string) => {
    try {
      await fetch(`/api/scenarios/${encodeURIComponent(file)}`, { method: "DELETE" });
      setProfiles((prev) => prev.filter((p) => p.file !== file));
    } catch {
      /* swallow */
    }
  };

  const handleReportClick = async (id: string) => {
    try {
      const res = await fetch(`/api/reports/${id}`);
      const report: Report = await res.json();
      onShowReport(report);
    } catch {
      /* swallow */
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await fetch(`/api/reports/${id}`, { method: "DELETE" });
      setReports((prev) => prev.filter((r) => r.id !== id));
    } catch {
      /* swallow */
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-65px)] flex-col items-center p-6">
      {/* Hero area with glow */}
      <div className="relative flex w-full flex-col items-center pt-[12vh] pb-10">
        {/* Background glow */}
        <div className="hero-glow pointer-events-none absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />

        <h2 className="hero-title relative mb-3 text-center text-4xl font-bold tracking-tight">
          Chaos Engineering
        </h2>
        <p className="relative mb-8 max-w-[440px] text-center text-[15px] leading-relaxed text-dim">
          Test how your application handles network failures,
          slow responses, and corrupted data.
        </p>

        <form
          className="relative flex w-full max-w-[560px] overflow-hidden rounded-xl border border-border bg-surface shadow-[0_0_40px_rgba(124,107,240,0.06)]  transition-all focus-within:border-accent focus-within:shadow-[0_0_40px_rgba(124,107,240,0.12)]"
          onSubmit={handleSubmit}
        >
          <input
            ref={inputRef}
            type="url"
            placeholder="https://your-app.com"
            required
            className="flex-1 border-none bg-transparent px-5 py-4 text-[15px] text-text outline-none placeholder:text-dim/50"
          />
          <button
            type="submit"
            disabled={submitting}
            className="m-1.5 cursor-pointer whitespace-nowrap rounded-lg border-none bg-accent px-7 py-3 text-[15px] font-semibold text-white transition-all hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {submitting ? "Starting..." : "Test"}
          </button>
        </form>

        <label className="relative mt-4 flex cursor-pointer select-none items-center gap-2 text-sm text-dim transition-colors hover:text-text">
          <input
            ref={authRef}
            type="checkbox"
            className="size-4 accent-accent"
          />
          This site requires login
        </label>
      </div>

      {/* Saved profiles */}
      {profiles.length > 0 && (
        <div className="mt-4 w-full max-w-[640px]">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-dim/60">
            Saved Chaos Profiles
          </h3>
          <div className="flex flex-col gap-1.5">
            {profiles.map((p) => (
              <div
                key={p.file}
                className="group flex cursor-pointer items-center gap-4 rounded-lg border border-transparent bg-surface/50 px-4 py-3 transition-all hover:border-border hover:bg-surface"
                onClick={() => onPreviewProfile(p)}
              >
                <span className="min-w-[42px] rounded-md bg-accent/15 px-2 py-0.5 text-center text-[13px] font-bold text-accent">
                  {p.scenarioCount}
                </span>
                <span className="min-w-0 flex-1 truncate text-sm text-text/80" title={p.url}>
                  {p.url}
                </span>
                {p.filter && (
                  <span className="shrink-0 rounded-full bg-border px-2 py-0.5 text-[11px] text-dim">
                    {p.filter}
                  </span>
                )}
                <span className="whitespace-nowrap text-xs text-dim/50">
                  {timeAgo(p.savedAt)}
                </span>
                <button
                  className="cursor-pointer border-none bg-transparent p-1 text-sm leading-none text-dim opacity-0 transition-all group-hover:opacity-60 hover:!text-critical hover:!opacity-100"
                  title="Delete profile"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteProfile(p.file);
                  }}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Report history */}
      {reports.length > 0 && (
        <div className="mt-4 w-full max-w-[640px]">
          <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-dim/60">
            Previous Reports
          </h3>
          <div className="flex flex-col gap-1.5">
            {reports.map((r) => {
              const c = r.findingCounts;
              const tier = scoreTier(r.score);
              return (
                <div
                  key={r.id}
                  className="group flex cursor-pointer items-center gap-4 rounded-lg border border-transparent bg-surface/50 px-4 py-3 transition-all hover:border-border hover:bg-surface"
                  onClick={() => handleReportClick(r.id)}
                >
                  <span
                    className={`min-w-[42px] rounded-md px-2 py-0.5 text-center text-[13px] font-bold ${SCORE_BG[tier]}`}
                  >
                    {r.score}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-sm text-text/80" title={r.url}>
                    {r.url}
                  </span>
                  <span className="flex gap-2 text-xs text-dim">
                    {c.critical > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="size-1.5 rounded-full bg-critical" />
                        {c.critical}
                      </span>
                    )}
                    {c.major > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="size-1.5 rounded-full bg-major" />
                        {c.major}
                      </span>
                    )}
                    {c.minor > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="size-1.5 rounded-full bg-minor" />
                        {c.minor}
                      </span>
                    )}
                    {c.good > 0 && (
                      <span className="flex items-center gap-1">
                        <span className="size-1.5 rounded-full bg-good" />
                        {c.good}
                      </span>
                    )}
                  </span>
                  <span className="whitespace-nowrap text-xs text-dim/50">
                    {timeAgo(r.timestamp)}
                  </span>
                  <button
                    className="cursor-pointer border-none bg-transparent p-1 text-sm leading-none text-dim opacity-0 transition-all group-hover:opacity-60 hover:!text-accent hover:!opacity-100"
                    title="Retest this URL"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (submitting) return;
                      setSubmitting(true);
                      onStartTest(r.url, false);
                    }}
                  >
                    ↻
                  </button>
                  <button
                    className="cursor-pointer border-none bg-transparent p-1 text-sm leading-none text-dim opacity-0 transition-all group-hover:opacity-60 hover:!text-critical hover:!opacity-100"
                    title="Delete report"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(r.id);
                    }}
                  >
                    &times;
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
