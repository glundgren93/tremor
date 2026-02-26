import { useCallback, useEffect, useRef, useState } from "react";
import { FindingCard } from "./FindingCard";
import { FindingModal } from "./FindingModal";
import type { AgentEntry, DashboardFinding, Phase } from "./types";

function mapToViewport(
  e: React.MouseEvent,
  img: HTMLImageElement,
): { x: number; y: number } | null {
  const rect = img.getBoundingClientRect();
  const imgAspect = img.naturalWidth / img.naturalHeight;
  const boxAspect = rect.width / rect.height;
  let displayW: number, displayH: number, offsetX: number, offsetY: number;
  if (imgAspect > boxAspect) {
    displayW = rect.width;
    displayH = rect.width / imgAspect;
    offsetX = 0;
    offsetY = (rect.height - displayH) / 2;
  } else {
    displayH = rect.height;
    displayW = rect.height * imgAspect;
    offsetX = (rect.width - displayW) / 2;
    offsetY = 0;
  }
  const x = ((e.clientX - rect.left - offsetX) / displayW) * img.naturalWidth;
  const y = ((e.clientY - rect.top - offsetY) / displayH) * img.naturalHeight;
  if (x < 0 || y < 0 || x > img.naturalWidth || y > img.naturalHeight) return null;
  return { x: Math.round(x), y: Math.round(y) };
}

const WORKER_COLORS = [
  "rgb(129, 140, 248)", // indigo
  "rgb(52, 211, 153)", // emerald
  "rgb(251, 191, 36)", // amber
  "rgb(244, 114, 182)", // pink
  "rgb(96, 165, 250)", // blue
  "rgb(167, 139, 250)", // violet
];

function workerColor(workerId: number): string {
  return WORKER_COLORS[(workerId - 1) % WORKER_COLORS.length] ?? WORKER_COLORS[0] ?? "#818cf8";
}

export function TestingView({
  phase,
  screenshot,
  findings,
  progress,
  agentEntries,
  currentTest,
  authActive,
  workerCount,
  activeWorkerId,
  onStop,
  onAuthDone,
  send,
}: {
  phase: Phase | null;
  screenshot: string | null;
  findings: DashboardFinding[];
  progress: { current: number; total: number };
  agentEntries: AgentEntry[];
  currentTest: string;
  authActive: boolean;
  workerCount: number;
  activeWorkerId: number;
  onStop: () => void;
  onAuthDone: () => void;
  send: (msg: Record<string, unknown>) => void;
}) {
  const [modalFinding, setModalFinding] = useState<DashboardFinding | null>(null);
  const agentPanelRef = useRef<HTMLDivElement>(null);
  const browserFrameRef = useRef<HTMLDivElement>(null);
  const findingsPanelRef = useRef<HTMLDivElement>(null);

  const filteredEntries =
    workerCount > 1
      ? agentEntries.filter((e) => e.workerId === activeWorkerId)
      : agentEntries;

  // Auto-scroll agent panel
  useEffect(() => {
    const el = agentPanelRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [filteredEntries]);

  // Auto-scroll findings
  useEffect(() => {
    const el = findingsPanelRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [findings]);

  const isPulsing =
    phase === "testing" ||
    phase === "launching" ||
    phase === "navigating" ||
    phase === "capturing" ||
    phase === "generating" ||
    phase === "waiting_for_auth";
  const pctVal = progress.total > 0 ? Math.min(100, Math.round((progress.current / progress.total) * 100)) : 0;

  const handleFrameClick = useCallback(
    (e: React.MouseEvent) => {
      if (!authActive) return;
      const img = browserFrameRef.current?.querySelector("img");
      if (!img) return;
      const coords = mapToViewport(e, img);
      if (!coords) return;
      send({ type: "input_click", x: coords.x, y: coords.y });
      browserFrameRef.current?.focus();
    },
    [authActive, send],
  );

  const handleFrameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!authActive) return;
      if ((e.metaKey || e.ctrlKey) && e.key === "v") return;
      e.preventDefault();
      send({ type: "input_key", key: e.key });
    },
    [authActive, send],
  );

  const handleFramePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!authActive) return;
      e.preventDefault();
      const text = e.clipboardData?.getData("text");
      if (text) send({ type: "input_type", text });
    },
    [authActive, send],
  );

  return (
    <div className="flex h-[calc(100vh-65px)] flex-col p-3">
      <div className="grid min-h-0 flex-1 grid-cols-2 gap-3">
        {/* Left column: Browser + Agent Activity */}
        <div className="flex min-h-0 flex-col gap-3">
          {/* Worker tabs */}
          {workerCount > 1 && (
            <div className="flex shrink-0 gap-1">
              {Array.from({ length: workerCount }, (_, i) => {
                const wId = i + 1;
                const isActive = wId === activeWorkerId;
                return (
                  <button
                    key={wId}
                    className={`flex cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
                      isActive
                        ? "bg-black text-white"
                        : "border-transparent bg-surface text-dim hover:bg-border hover:text-text"
                    }`}
                    style={{
                      borderBottomColor: isActive ? workerColor(wId) : "transparent",
                    }}
                    onClick={() => send({ type: "switch_worker", workerId: wId })}
                  >
                    <span
                      className="inline-block size-2 rounded-full"
                      style={{ backgroundColor: workerColor(wId) }}
                    />
                    W{wId}
                  </button>
                );
              })}
            </div>
          )}

          {/* Browser frame — fixed 16:9 aspect ratio */}
          <div
            ref={browserFrameRef}
            tabIndex={0}
            className={`relative flex aspect-video shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-black ${
              isPulsing ? "animate-pulse-border" : ""
            } ${authActive ? "cursor-crosshair focus:border-accent focus:shadow-[0_0_0_3px_var(--color-accent-glow)] focus:outline-none" : ""}`}
            onClick={handleFrameClick}
            onKeyDown={handleFrameKeyDown}
            onPaste={handleFramePaste}
          >
            {screenshot ? (
              <img
                className={`h-full w-full object-contain ${authActive ? "pointer-events-none" : ""}`}
                src={`data:image/jpeg;base64,${screenshot}`}
                alt="Live browser screenshot"
              />
            ) : (
              <span className="text-sm text-dim">Launching browser...</span>
            )}
            {workerCount > 1 && (
              <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded-md bg-black/70 px-2 py-1 text-[11px] font-medium text-white backdrop-blur-sm">
                <span
                  className="inline-block size-2 rounded-full"
                  style={{ backgroundColor: workerColor(activeWorkerId) }}
                />
                Worker {activeWorkerId} of {workerCount}
              </div>
            )}
          </div>

          {/* Auth bar */}
          {authActive && (
            <div className="flex shrink-0 items-center justify-center gap-3 rounded-lg border border-accent bg-accent/10 px-4 py-2.5 text-sm text-dim">
              <span>Log in using the browser view above, then click:</span>
              <button
                className="cursor-pointer rounded-lg border-none bg-accent px-6 py-3 text-[15px] font-semibold text-white transition-opacity hover:opacity-85"
                onClick={onAuthDone}
              >
                I'm logged in
              </button>
            </div>
          )}

          {/* Agent activity panel */}
          <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-hidden rounded-lg border border-border bg-[#0d0d14] p-3">
            {/* Current test status */}
            <div
              className="shrink-0 rounded-md border border-border bg-surface px-3 py-2 text-sm text-dim"
              dangerouslySetInnerHTML={{
                __html: currentTest.replace(
                  /^(Phase|Testing|Tool|Discovered|Generated): (.+)$/,
                  '$1: <span class="font-medium text-text">$2</span>',
                ),
              }}
            />

            {/* Agent log */}
            <div
              ref={agentPanelRef}
              className="min-h-0 flex-1 overflow-y-auto font-mono text-sm leading-relaxed text-dim"
              style={{ scrollBehavior: "smooth" }}
            >
              {filteredEntries.length === 0 ? (
                <div className="flex h-full items-center justify-center text-dim/50">
                  Waiting for agent to start...
                </div>
              ) : (
                filteredEntries.map((entry) => {
                  const badge =
                    workerCount > 1 && entry.workerId ? (
                      <span
                        key={`badge-${entry.id}`}
                        className="mr-1.5 inline-flex items-center rounded px-1 py-0.5 text-[10px] font-bold leading-none text-black"
                        style={{ backgroundColor: workerColor(entry.workerId) }}
                      >
                        W{entry.workerId}
                      </span>
                    ) : null;

                  return entry.kind === "thinking" ? (
                    <div key={entry.id} className="mb-1.5 opacity-80 last:mb-0">
                      {badge}
                      {entry.text}
                    </div>
                  ) : (
                    <div
                      key={entry.id}
                      className="my-1 mb-1.5 border-l-2 border-accent pl-2 text-accent last:mb-0"
                    >
                      {badge}
                      <span className="font-semibold text-text">{entry.toolName}</span>
                      {entry.text.slice(entry.toolName?.length ?? 0)}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </div>

        {/* Right column: Findings */}
        <div className="flex min-h-0 flex-col gap-2 overflow-hidden rounded-lg border border-border p-3">
          <div className="flex shrink-0 items-center justify-between">
            <div className="text-[13px] font-semibold uppercase tracking-wider text-dim">
              Findings
            </div>
            <div className="text-xs text-dim">
              {findings.length} finding{findings.length === 1 ? "" : "s"}
            </div>
          </div>
          <div
            ref={findingsPanelRef}
            className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
          >
            {findings.length === 0 ? (
              <div className="flex h-full items-center justify-center text-dim/50">
                No findings yet
              </div>
            ) : (
              findings.map((f) => (
                <FindingCard key={f.id} finding={f} onClick={() => setModalFinding(f)} />
              ))
            )}
          </div>
        </div>
      </div>

      <FindingModal finding={modalFinding} onClose={() => setModalFinding(null)} />
    </div>
  );
}
