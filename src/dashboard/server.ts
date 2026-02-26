import { createReadStream, existsSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { deleteScenarioFile, listScenarioFiles, loadScenariosFromFile, saveScenariosToFile } from "../core/scenario-files";
import { state } from "../state";
import { findingRecordings } from "../tools/report";
import { Orchestrator } from "./orchestrator";
import type { ClientMessage, ServerMessage } from "./protocol";

const __dirname = dirname(fileURLToPath(import.meta.url));
const htmlDir = join(__dirname, "html");
const REPORTS_DIR = join(homedir(), ".tremor", "reports");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".mjs": "application/javascript",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const PORT = Number(process.env.PORT) || 3000;

function handleApiRequest(
  req: { method?: string; url?: string },
  res: import("node:http").ServerResponse,
): boolean {
  const method = req.method ?? "GET";
  const url = req.url ?? "/";

  // GET /api/reports — list all reports
  if (method === "GET" && url === "/api/reports") {
    res.writeHead(200, { "Content-Type": "application/json" });
    try {
      if (!existsSync(REPORTS_DIR)) {
        res.end("[]");
        return true;
      }
      const files = readdirSync(REPORTS_DIR)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse();
      const reports = files.map((f) => {
        try {
          const raw = readFileSync(join(REPORTS_DIR, f), "utf-8");
          const data = JSON.parse(raw);
          const counts = { critical: 0, major: 0, minor: 0, good: 0 };
          for (const finding of data.findings ?? []) {
            if (finding.severity in counts) {
              counts[finding.severity as keyof typeof counts]++;
            }
          }
          return {
            id: basename(f, ".json"),
            url: data.url,
            timestamp: data.timestamp,
            score: data.score,
            findingCounts: counts,
            ...(data.testConfig ? { testConfig: data.testConfig } : {}),
          };
        } catch {
          return null;
        }
      });
      res.end(JSON.stringify(reports.filter(Boolean)));
    } catch {
      res.end("[]");
    }
    return true;
  }

  // GET /api/reports/:id — get a single report
  if (method === "GET" && url.startsWith("/api/reports/")) {
    const id = url.slice("/api/reports/".length);
    const filePath = join(REPORTS_DIR, `${id}.json`);
    if (!existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Report not found" }));
      return true;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(readFileSync(filePath, "utf-8"));
    return true;
  }

  // DELETE /api/reports/:id — delete a report
  if (method === "DELETE" && url.startsWith("/api/reports/")) {
    const id = url.slice("/api/reports/".length);
    const filePath = join(REPORTS_DIR, `${id}.json`);
    if (!existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Report not found" }));
      return true;
    }
    unlinkSync(filePath);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return true;
  }

  // GET /api/scenarios — list saved scenario files
  if (method === "GET" && url === "/api/scenarios") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(listScenarioFiles()));
    return true;
  }

  // GET /api/scenarios/:file — get a single scenario file
  if (method === "GET" && url.startsWith("/api/scenarios/")) {
    const file = decodeURIComponent(url.slice("/api/scenarios/".length));
    try {
      const data = loadScenariosFromFile(file);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Scenario file not found" }));
    }
    return true;
  }

  // DELETE /api/scenarios/:file — delete a scenario file
  if (method === "DELETE" && url.startsWith("/api/scenarios/")) {
    const file = decodeURIComponent(url.slice("/api/scenarios/".length));
    if (deleteScenarioFile(file)) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } else {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Scenario file not found" }));
    }
    return true;
  }

  // GET /api/recordings/:findingId — serve a video recording for a finding
  if (method === "GET" && url.startsWith("/api/recordings/")) {
    const findingId = decodeURIComponent(url.slice("/api/recordings/".length));
    let filePath: string | undefined;

    // 1. Check in-memory map (current/recent test — temp dir)
    filePath = findingRecordings.get(findingId);

    // 2. Fall back to persistent storage (past reports)
    if (!filePath || !existsSync(filePath)) {
      const recordingsBase = join(REPORTS_DIR, "recordings");
      if (existsSync(recordingsBase)) {
        const fileName = `finding-${findingId}.webm`;
        for (const reportDir of readdirSync(recordingsBase)) {
          const candidate = join(recordingsBase, reportDir, fileName);
          if (existsSync(candidate)) {
            filePath = candidate;
            break;
          }
        }
      }
    }

    if (!filePath || !existsSync(filePath)) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Recording not found" }));
      return true;
    }

    const stat = statSync(filePath);
    res.writeHead(200, {
      "Content-Type": "video/webm",
      "Content-Length": stat.size,
    });
    createReadStream(filePath).pipe(res);
    return true;
  }

  return false;
}

const httpServer = createServer((req, res) => {
  if (handleApiRequest(req, res)) return;

  // Serve static files from html/ directory (Vite outputs assets/ subdirectory)
  const urlPath = req.url === "/" ? "/index.html" : req.url ?? "/index.html";
  const ext = extname(urlPath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  // Resolve full path under htmlDir (supports nested paths like /assets/index-abc.js)
  const filePath = join(htmlDir, urlPath);

  try {
    const content = readFileSync(filePath);
    res.writeHead(200, { "Content-Type": contentType });
    res.end(content);
  } catch {
    // Fall back to index.html for SPA routing
    try {
      const content = readFileSync(join(htmlDir, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(content);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  }
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  let orchestrator: Orchestrator | null = null;
  let lastUrl = "";

  const emit = (msg: ServerMessage) => {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  };

  ws.on("message", (raw) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    if (msg.type === "start_test") {
      if (orchestrator) {
        orchestrator.stop();
      }
      lastUrl = msg.url;
      orchestrator = new Orchestrator(emit);
      orchestrator.setup(msg.url, {
        requiresAuth: msg.requiresAuth,
        filter: msg.filter,
        scenarioFile: msg.scenarioFile,
        scenarioIds: msg.scenarioIds,
        presets: msg.presets,
        exploratory: msg.exploratory,
        cpuProfile: msg.cpuProfile,
      });
    }

    if (msg.type === "auth_ready") {
      orchestrator?.resumeAfterAuth();
    }

    if (msg.type === "input_click") {
      if (orchestrator?.isAwaitingAuth()) {
        state.page?.mouse.click(msg.x, msg.y).catch(() => {});
      }
    }

    if (msg.type === "input_key") {
      if (orchestrator?.isAwaitingAuth()) {
        state.page?.keyboard.press(msg.key).catch(() => {});
      }
    }

    if (msg.type === "input_type") {
      if (orchestrator?.isAwaitingAuth()) {
        state.page?.keyboard.type(msg.text).catch(() => {});
      }
    }

    if (msg.type === "switch_worker") {
      orchestrator?.switchScreencast(msg.workerId);
    }

    if (msg.type === "save_scenarios") {
      if (state.generatedScenarios.length > 0) {
        try {
          const result = saveScenariosToFile(state.generatedScenarios, lastUrl, { name: msg.name });
          emit({ type: "scenarios_saved", file: result.file, count: result.count });
        } catch (err) {
          emit({ type: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    }

    if (msg.type === "start_testing") {
      orchestrator?.startTesting(msg.scenarioIds, msg.presets, { exploratory: msg.exploratory, cpuProfile: msg.cpuProfile });
    }

    if (msg.type === "stop_test") {
      orchestrator?.stop();
      orchestrator = null;
    }
  });

  ws.on("close", () => {
    orchestrator?.stop();
    orchestrator = null;
  });
});

httpServer.listen(PORT, () => {
  console.log(`Tremor Dashboard running at http://localhost:${PORT}`);
});
