import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEntry, CompleteSummary, DashboardFinding, Phase, ScenarioFileItem, ScenarioItem } from "./types";

export type WsState = {
  phase: Phase | null;
  score: number;
  screenshot: string | null;
  findings: DashboardFinding[];
  scenarios: ScenarioItem[];
  progress: { current: number; total: number };
  completeSummary: CompleteSummary | null;
  error: string | null;
  endpointCount: number;
  scenarioCount: number;
  agentEntries: AgentEntry[];
  currentTest: string;
  authActive: boolean;
  workerCount: number;
  activeWorkerId: number;
  scenariosSaved: { file: string; count: number } | null;
};

const INITIAL_STATE: WsState = {
  phase: null,
  score: 0,
  screenshot: null,
  findings: [],
  scenarios: [],
  progress: { current: 0, total: 0 },
  completeSummary: null,
  error: null,
  endpointCount: 0,
  scenarioCount: 0,
  agentEntries: [],
  currentTest: "",
  authActive: false,
  workerCount: 0,
  activeWorkerId: 1,
  scenariosSaved: null,
};

const MAX_AGENT_ENTRIES = 50;
let entryIdCounter = 0;

export function useWebSocket() {
  const [state, setState] = useState<WsState>(INITIAL_STATE);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const connect = useCallback(() => {
    const wsHost = import.meta.env.VITE_WS_HOST || location.host;
    const ws = new WebSocket(`ws://${wsHost}`);
    wsRef.current = ws;

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      setState((prev) => handleMessage(prev, msg));
    });

    ws.addEventListener("close", () => {
      reconnectTimer.current = setTimeout(connect, 2000);
    });
  }, []);

  useEffect(() => {
    connect();
    return () => {
      clearTimeout(reconnectTimer.current);
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((msg: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }, []);

  const resetState = useCallback(() => {
    setState(INITIAL_STATE);
  }, []);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  const setScenarios = useCallback((scenarios: ScenarioItem[]) => {
    setState((prev) => ({ ...prev, scenarios }));
  }, []);

  const clearCompleted = useCallback(() => {
    setState((prev) => ({ ...prev, completeSummary: null }));
  }, []);

  return { state, send, resetState, clearError, setScenarios, clearCompleted };
}

function handleMessage(prev: WsState, msg: Record<string, unknown>): WsState {
  switch (msg.type) {
    case "status": {
      const phase = msg.phase as Phase;
      const LABELS: Record<string, string> = {
        launching: "Launching Browser",
        navigating: "Navigating",
        capturing: "Capturing Traffic",
        generating: "Generating Scenarios",
        testing: "Testing",
        complete: "Complete",
        waiting_for_auth: "Waiting for Login",
      };
      return {
        ...prev,
        phase,
        currentTest: `Phase: ${LABELS[phase] || phase}`,
        authActive: phase === "waiting_for_auth",
      };
    }

    case "screenshot":
      return { ...prev, screenshot: msg.data as string };

    case "finding": {
      const f = msg.finding as DashboardFinding;
      return {
        ...prev,
        findings: [...prev.findings, f],
        currentTest: `Testing: ${f.scenarioName}`,
      };
    }

    case "progress":
      return {
        ...prev,
        progress: {
          current: msg.current as number,
          total: msg.total as number,
        },
      };

    case "endpoints_discovered":
      return {
        ...prev,
        endpointCount: msg.count as number,
        currentTest: `Discovered ${msg.count} API endpoint${(msg.count as number) === 1 ? "" : "s"}`,
      };

    case "scenarios_generated":
      return {
        ...prev,
        scenarioCount: msg.count as number,
        currentTest: `Generated ${msg.count} test scenario${(msg.count as number) === 1 ? "" : "s"}`,
      };

    case "scenarios_list":
      return {
        ...prev,
        scenarios: msg.scenarios as ScenarioItem[],
      };

    case "score": {
      const value = Math.max(0, Math.min(100, msg.value as number));
      return { ...prev, score: value };
    }

    case "error":
      return { ...prev, error: msg.message as string };

    case "complete":
      return {
        ...prev,
        completeSummary: msg.summary as CompleteSummary,
        phase: "complete",
      };

    case "workers_started":
      return { ...prev, workerCount: msg.count as number, activeWorkerId: 1 };

    case "worker_switched":
      return { ...prev, activeWorkerId: msg.workerId as number };

    case "scenarios_saved":
      return { ...prev, scenariosSaved: { file: msg.file as string, count: msg.count as number } };

    case "agent_thinking": {
      const entry: AgentEntry = {
        id: ++entryIdCounter,
        kind: "thinking",
        text: msg.text as string,
        workerId: msg.workerId as number | undefined,
      };
      const entries = [...prev.agentEntries, entry].slice(-MAX_AGENT_ENTRIES);
      return { ...prev, agentEntries: entries };
    }

    case "tool_call": {
      const toolName = (msg.tool as string).replace(/^mcp__tremor__/, "");
      const args = msg.args as Record<string, unknown>;
      const argsStr =
        Object.keys(args).length > 0
          ? ` ${Object.entries(args)
              .map(([k, v]) => {
                const val = typeof v === "string" ? v : JSON.stringify(v);
                const short = val.length > 40 ? `${val.slice(0, 37)}...` : val;
                return `${k}=${short}`;
              })
              .join(" ")}`
          : "";
      const entry: AgentEntry = {
        id: ++entryIdCounter,
        kind: "tool_call",
        text: `${toolName}${argsStr}`,
        toolName,
        workerId: msg.workerId as number | undefined,
      };
      const entries = [...prev.agentEntries, entry].slice(-MAX_AGENT_ENTRIES);
      return {
        ...prev,
        agentEntries: entries,
        currentTest: `Tool: ${toolName}`,
      };
    }

    default:
      return prev;
  }
}
