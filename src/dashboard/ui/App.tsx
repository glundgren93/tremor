import { useCallback, useEffect, useRef, useState } from "react";
import { CompleteOverlay } from "./CompleteOverlay";
import { IdleView } from "./IdleView";
import { ReportDetailView } from "./ReportDetailView";
import { ReportPreview } from "./ReportPreview";
import { ScenarioSelectView } from "./ScenarioSelectView";
import { TestingView } from "./TestingView";
import type { Report, ScenarioFileItem, ScenarioItem } from "./types";
import { useWebSocket } from "./useWebSocket";

type View = "idle" | "setup" | "scenarioSelect" | "testing" | "reportDetail" | "reportPreview";

export function App() {
  const { state, send, resetState, clearError, setScenarios, clearCompleted } = useWebSocket();
  const [view, setView] = useState<View>("idle");
  const [showComplete, setShowComplete] = useState(false);
  const [reportData, setReportData] = useState<Report | null>(null);
  const [activeProfile, setActiveProfile] = useState<{ url: string; file: string } | null>(null);
  const urlRef = useRef("");
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Transition to scenario select when scenarios arrive during setup phase
  useEffect(() => {
    if (state.scenarios.length > 0 && view === "setup") {
      setView("scenarioSelect");
    }
  }, [state.scenarios, view]);

  // Transition to testing when testing phase starts (e.g. profile run that skips scenario select)
  useEffect(() => {
    if (state.phase === "testing" && view === "setup") {
      setView("testing");
    }
  }, [state.phase, view]);

  // Show complete overlay
  useEffect(() => {
    if (state.completeSummary && view === "testing") {
      setShowComplete(true);
    }
  }, [state.completeSummary, view]);

  // Auto-dismiss errors
  useEffect(() => {
    if (state.error) {
      clearTimeout(errorTimerRef.current);
      errorTimerRef.current = setTimeout(clearError, 5000);
    }
  }, [state.error, clearError]);

  const goIdle = useCallback(() => {
    send({ type: "stop_test" });
    resetState();
    setView("idle");
    setShowComplete(false);
    setReportData(null);
    setActiveProfile(null);
  }, [send, resetState]);

  const handleStartTest = useCallback(
    (url: string, requiresAuth: boolean) => {
      urlRef.current = url;
      resetState();
      setShowComplete(false);
      setActiveProfile(null);
      send({ type: "start_test", url, requiresAuth });
      setView("setup");
    },
    [send, resetState],
  );

  const handlePreviewProfile = useCallback(
    async (profile: ScenarioFileItem) => {
      try {
        const res = await fetch(`/api/scenarios/${encodeURIComponent(profile.file)}`);
        const data = await res.json();
        const items: ScenarioItem[] = data.scenarios.map((s: { id: string; name: string; description: string; category: string; endpoint: { method: string; pattern: string }; priority: number; endpointType?: string }) => ({
          id: s.id,
          name: s.name,
          description: s.description,
          category: s.category,
          endpoint: `${s.endpoint.method} ${s.endpoint.pattern}`,
          priority: s.priority,
          endpointType: s.endpointType,
        }));
        resetState();
        setScenarios(items);
        setActiveProfile({ url: profile.url, file: profile.file });
        urlRef.current = profile.url;
        setView("scenarioSelect");
      } catch {
        /* swallow */
      }
    },
    [resetState, setScenarios],
  );

  const handleSaveProfile = useCallback(() => {
    send({ type: "save_scenarios" });
  }, [send]);

  const handleRunSelected = useCallback(
    (scenarioIds: string[], presets: string[], exploratory: boolean, cpuProfile: string | null) => {
      if (activeProfile) {
        // Profile mode: launch browser + load file + run directly
        send({ type: "start_test", url: activeProfile.url, scenarioFile: activeProfile.file, scenarioIds, presets, exploratory, cpuProfile: cpuProfile ?? undefined });
        setActiveProfile(null);
        setView("setup");
      } else {
        // Clear any stale completion data before transitioning to testing view
        clearCompleted();
        setShowComplete(false);
        send({ type: "start_testing", scenarioIds, presets, exploratory, cpuProfile: cpuProfile ?? undefined });
        setView("testing");
      }
    },
    [send, activeProfile, clearCompleted],
  );

  const handleCancelSelect = useCallback(() => {
    goIdle();
  }, [goIdle]);

  const handleStop = useCallback(() => {
    goIdle();
  }, [goIdle]);

  const handleAuthDone = useCallback(() => {
    send({ type: "auth_ready" });
  }, [send]);

  const buildCurrentReport = useCallback((): Report => {
    return {
      url: urlRef.current,
      timestamp: Date.now(),
      score: state.completeSummary?.score ?? state.score,
      summary: state.completeSummary,
      findings: state.findings,
    };
  }, [state.completeSummary, state.score, state.findings]);

  const handleViewReport = useCallback(() => {
    setShowComplete(false);
    setReportData(buildCurrentReport());
    setView("reportDetail");
  }, [buildCurrentReport]);

  const handlePreviewReport = useCallback(() => {
    setShowComplete(false);
    const data = reportData ?? buildCurrentReport();
    setReportData(data);
    setView("reportPreview");
  }, [buildCurrentReport, reportData]);

  const handleShowSavedReport = useCallback((report: Report) => {
    setReportData(report);
    setView("reportDetail");
  }, []);

  // Score ring
  const scoreVisible = view === "testing" || showComplete;
  const scoreValue = state.score;
  const ringColor =
    scoreValue >= 80
      ? "var(--color-good)"
      : scoreValue >= 50
        ? "var(--color-minor)"
        : "var(--color-critical)";

  const phaseVisible = view !== "idle" && view !== "reportDetail" && view !== "reportPreview";
  const PHASE_LABELS: Record<string, string> = {
    launching: "Launching Browser",
    navigating: "Navigating",
    capturing: "Capturing Traffic",
    generating: "Generating Scenarios",
    testing: "Testing",
    complete: "Complete",
    waiting_for_auth: "Waiting for Login",
  };
  const phaseText =
    view === "scenarioSelect"
      ? "Select Scenarios"
      : state.phase
        ? (PHASE_LABELS[state.phase] ?? state.phase)
        : "";

  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-surface px-6 py-4">
        <div className="flex items-center gap-4">
          <div
            className="cursor-pointer text-xl font-bold tracking-widest text-accent"
            onClick={goIdle}
          >
            TREMOR
          </div>
          {phaseVisible && phaseText && (
            <span className="rounded-full bg-border px-3 py-1 text-[13px] text-dim">
              {phaseText}
            </span>
          )}
          {state.workerCount > 1 && (view === "testing" || view === "setup") && (
            <span className="rounded-full bg-accent/20 px-3 py-1 text-[13px] text-accent">
              {state.workerCount} workers
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {(view === "setup" || view === "testing") && (
            <button
              className="cursor-pointer rounded-lg border border-border bg-transparent px-4 py-1.5 text-[13px] font-medium text-dim transition-colors hover:border-critical hover:bg-critical/10 hover:text-critical"
              onClick={handleStop}
            >
              Stop
            </button>
          )}
          {scoreVisible && (
            <div className="flex items-center gap-3 text-sm text-dim">
              <span>Resilience Score</span>
              <div
                className="score-ring flex size-12 items-center justify-center rounded-full text-base font-bold text-text"
                style={
                  {
                    "--pct": String(scoreValue),
                    "--ring-color": ringColor,
                  } as React.CSSProperties
                }
              >
                <div className="flex size-9 items-center justify-center rounded-full bg-surface">
                  {scoreValue > 0 ? scoreValue : "\u2014"}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Views */}
      {view === "idle" && (
        <IdleView onStartTest={handleStartTest} onPreviewProfile={handlePreviewProfile} onShowReport={handleShowSavedReport} />
      )}

      {view === "setup" && (
        state.authActive ? (
          <TestingView
            phase={state.phase}
            screenshot={state.screenshot}
            findings={state.findings}
            progress={state.progress}
            agentEntries={state.agentEntries}
            currentTest={state.currentTest}
            authActive={state.authActive}
            workerCount={state.workerCount}
            activeWorkerId={state.activeWorkerId}
            onStop={handleStop}
            onAuthDone={handleAuthDone}
            send={send}
          />
        ) : (
          <div className="flex h-[calc(100vh-65px)] items-center justify-center">
            <div className="flex flex-col items-center gap-4">
              <div className="size-8 animate-spin rounded-full border-2 border-border border-t-accent" />
              <span className="text-sm text-dim">
                {state.phase === "launching" && "Launching browser..."}
                {state.phase === "navigating" && "Navigating to site..."}
                {state.phase === "capturing" && "Capturing network traffic..."}
                {state.phase === "generating" && "Generating test scenarios..."}
                {!state.phase && "Starting..."}
              </span>
            </div>
          </div>
        )
      )}

      {view === "scenarioSelect" && (
        <ScenarioSelectView
          scenarios={state.scenarios}
          onRunSelected={handleRunSelected}
          onCancel={handleCancelSelect}
          onSaveProfile={handleSaveProfile}
          profileSaved={state.scenariosSaved !== null}
        />
      )}

      {view === "testing" && (
        <TestingView
          phase={state.phase}
          screenshot={state.screenshot}
          findings={state.findings}
          progress={state.progress}
          agentEntries={state.agentEntries}
          currentTest={state.currentTest}
          authActive={state.authActive}
          workerCount={state.workerCount}
          activeWorkerId={state.activeWorkerId}
          onStop={handleStop}
          onAuthDone={handleAuthDone}
          send={send}
        />
      )}

      {view === "reportDetail" && reportData && (
        <ReportDetailView
          report={reportData}
          onBack={goIdle}
          onPreviewReport={handlePreviewReport}
        />
      )}

      {view === "reportPreview" && reportData && (
        <ReportPreview
          report={reportData}
          onBack={() => {
            setView("reportDetail");
          }}
        />
      )}

      {/* Complete overlay */}
      <CompleteOverlay
        summary={state.completeSummary}
        visible={showComplete}
        onRestart={goIdle}
        onViewReport={handleViewReport}
        onPreviewReport={handlePreviewReport}
      />

      {/* Error toast */}
      {state.error && (
        <div className="animate-slide-in fixed right-6 bottom-6 z-300 max-w-[400px] rounded-lg bg-critical px-5 py-3 text-sm text-white">
          {state.error}
        </div>
      )}
    </div>
  );
}
