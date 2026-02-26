import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import type { DashboardFinding } from "./types";

const SEV_LABEL: Record<string, string> = {
  critical: "bg-critical/15 text-critical",
  major: "bg-major/15 text-major",
  minor: "bg-minor/15 text-minor",
  good: "bg-good/15 text-good",
};

export function FindingModal({
  finding,
  onClose,
}: {
  finding: DashboardFinding | null;
  onClose: () => void;
}) {
  const [videoError, setVideoError] = useState(false);
  const [showVideo, setShowVideo] = useState(true);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  // Reset state when finding changes
  useEffect(() => {
    setVideoError(false);
    setShowVideo(true);
  }, [finding?.id]);

  if (!finding) return null;

  const hasVideo = !!finding.recordingPath && !videoError;
  const hasScreenshot = !!finding.screenshot;
  const hasMedia = hasVideo || hasScreenshot;

  return (
    <div
      className="fixed inset-0 z-200 flex items-center justify-center bg-[rgba(10,10,15,0.9)] p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="max-h-[90vh] w-full max-w-[1100px] overflow-y-auto rounded-xl border border-border bg-surface">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <h3 className="mr-3 min-w-0 flex-1 truncate text-base font-semibold">
            {finding.scenarioName}
          </h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase ${SEV_LABEL[finding.severity] ?? ""}`}
          >
            {finding.severity}
          </span>
          <button
            className="cursor-pointer border-none bg-none pl-3 text-2xl leading-none text-dim hover:text-text"
            onClick={onClose}
          >
            &times;
          </button>
        </div>

        {/* Body — two-column layout */}
        <div className={`flex gap-5 p-5 ${hasMedia ? "" : "flex-col"}`}>
          {/* Left: media */}
          {hasMedia && (
            <div className="flex min-w-0 flex-1 flex-col">
              {/* Toggle */}
              {hasVideo && hasScreenshot && (
                <div className="mb-2 flex gap-1 rounded-lg bg-black/30 p-0.5 w-fit">
                  <button
                    className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      showVideo
                        ? "bg-surface text-text"
                        : "bg-transparent text-dim hover:text-text"
                    }`}
                    onClick={() => setShowVideo(true)}
                  >
                    Video
                  </button>
                  <button
                    className={`cursor-pointer rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                      !showVideo
                        ? "bg-surface text-text"
                        : "bg-transparent text-dim hover:text-text"
                    }`}
                    onClick={() => setShowVideo(false)}
                  >
                    Screenshot
                  </button>
                </div>
              )}

              {/* Video player */}
              {hasVideo && (showVideo || !hasScreenshot) && (
                <video
                  key={finding.id}
                  className="w-full rounded-lg border border-border bg-black"
                  src={`/api/recordings/${finding.id}`}
                  controls
                  autoPlay
                  muted
                  preload="metadata"
                  onError={() => setVideoError(true)}
                >
                  <track kind="captions" />
                </video>
              )}

              {/* Screenshot */}
              {hasScreenshot && (!showVideo || !hasVideo) && (
                <img
                  className="w-full rounded-lg border border-border bg-black"
                  src={`data:image/jpeg;base64,${finding.screenshot}`}
                  alt="Screenshot"
                />
              )}
            </div>
          )}

          {/* Right: details */}
          <div className={`flex flex-col gap-3 ${hasMedia ? "w-[280px] shrink-0" : ""}`}>
            {!hasMedia && (
              <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-dim">
                No screenshot captured
              </div>
            )}

            <div className="flex flex-col gap-2 text-[13px]">
              {finding.endpoint && (
                <div className="text-dim">
                  Endpoint: <span className="font-medium text-text">{finding.endpoint}</span>
                </div>
              )}
              {finding.category && (
                <div className="text-dim">
                  Category: <span className="font-medium text-text">{finding.category}</span>
                </div>
              )}
              {finding.metrics?.lcp != null && (
                <div className="text-dim">
                  LCP:{" "}
                  <span className="font-medium text-text">{Math.round(finding.metrics.lcp)}ms</span>
                </div>
              )}
              {finding.metrics?.cls != null && (
                <div className="text-dim">
                  CLS: <span className="font-medium text-text">{finding.metrics.cls.toFixed(3)}</span>
                </div>
              )}
              {finding.metrics?.ttfb != null && (
                <div className="text-dim">
                  TTFB:{" "}
                  <span className="font-medium text-text">{Math.round(finding.metrics.ttfb)}ms</span>
                </div>
              )}
              {finding.metrics?.inp != null && (
                <div className="text-dim">
                  INP:{" "}
                  <span className="font-medium text-text">{Math.round(finding.metrics.inp)}ms</span>
                </div>
              )}
            </div>

            <div className="markdown-body text-sm leading-relaxed text-text">
              <Markdown>{finding.description}</Markdown>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
