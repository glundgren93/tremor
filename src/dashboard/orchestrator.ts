import type { CDPSession, Page } from "playwright";
import { deduplicateEndpoints, filterEndpoints } from "../core/endpoints";
import { installDiagnostics } from "../core/page-diagnostics";
import { loadScenariosFromFile } from "../core/scenario-files";
import { generateScenarios } from "../core/scenarios";
import { WEB_VITALS_INIT_SCRIPT } from "../core/web-vitals";
import { state, type WorkerContext } from "../state";
import { runAgentLoop } from "./agent";
import { type BrowserSession, launchBrowser, startScreencast, stopScreencast } from "./browser";
import type { ScenarioItem, ServerMessage } from "./protocol";
import { emitComplete } from "./report";
import { createFindingTracker } from "./scoring";
import { findingRecordings } from "../tools/report";

const CPU_PROFILE_RATES: Record<string, number> = {
  "mid-tier-mobile": 2,
  "low-end-mobile": 4,
  "very-slow-device": 6,
};

/** Split items into N chunks using round-robin distribution */
function splitIntoChunks<T>(items: T[], n: number): T[][] {
  const chunks: T[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < items.length; i++) {
    chunks[i % n]?.push(items[i] as T);
  }
  return chunks;
}

export class Orchestrator {
  private emit: (msg: ServerMessage) => void;
  private browser: BrowserSession | null = null;
  private stopped = false;
  private awaitingAuth = false;
  private estimatedTotal = 15;
  private url = "";
  private filter?: string;
  private workerPages: Page[] = [];
  private activeWorkerId = 1;
  private cpuProfile?: string;

  constructor(emit: (msg: ServerMessage) => void) {
    this.emit = emit;
  }

  /** Phase 1: Launch browser, navigate, capture traffic, generate scenarios, emit to UI */
  async setup(
    url: string,
    options?: {
      requiresAuth?: boolean;
      filter?: string;
      scenarioFile?: string;
      scenarioIds?: string[];
      presets?: string[];
      exploratory?: boolean;
      cpuProfile?: string;
    },
  ): Promise<void> {
    this.url = url;
    this.filter = options?.filter;
    this.cpuProfile = options?.cpuProfile;
    try {
      this.browser = await launchBrowser(url, this.emit, () => this.stopped);
      if (this.stopped || !this.browser) return;

      if (options?.requiresAuth) {
        this.awaitingAuth = true;
        this.emit({ type: "status", phase: "waiting_for_auth" });
        return;
      }

      // Load from saved scenario file with pre-selected IDs — launch browser + run directly
      if (options?.scenarioFile && options?.scenarioIds) {
        await this.loadAndRun(options.scenarioFile, options.scenarioIds, options.presets ?? [], {
          exploratory: options.exploratory,
          cpuProfile: options.cpuProfile,
        });
        return;
      }

      // Load from saved scenario file — skip capture/generate, show ScenarioSelectView
      if (options?.scenarioFile) {
        await this.loadFromFile(options.scenarioFile);
        return;
      }

      await this.captureAndGenerate();
    } catch (err) {
      if (!this.stopped) {
        this.emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Resume after user has logged in via the interactive screencast */
  async resumeAfterAuth(): Promise<void> {
    if (!this.awaitingAuth || !this.browser || this.stopped) return;
    this.awaitingAuth = false;

    try {
      // Keep requests discovered during login browsing — deduplicateEndpoints
      // will consolidate duplicates, and any stray login endpoints are harmless
      // compared to losing authenticated API traffic the user discovered.

      // Re-navigate (now authenticated via session/cookies)
      this.emit({ type: "status", phase: "navigating" });
      await state.page?.goto(this.url, { waitUntil: "load", timeout: 30000 });
      if (this.stopped) return;

      await this.captureAndGenerate();
    } catch (err) {
      if (!this.stopped) {
        this.emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /** Wait for traffic, deduplicate endpoints, generate scenarios */
  private async captureAndGenerate(): Promise<void> {
    // Wait for traffic to settle
    this.emit({ type: "status", phase: "capturing" });
    await new Promise((r) => setTimeout(r, 3000));

    // Emit endpoint info for the UI
    let endpoints = deduplicateEndpoints(state.capturedRequests);
    if (this.filter) {
      endpoints = filterEndpoints(endpoints, this.filter);
    }
    this.emit({
      type: "endpoints_discovered",
      count: endpoints.length,
      endpoints: endpoints.map((e) => `${e.method} ${e.pattern}`),
    });

    // Generate scenarios from captured traffic
    this.emit({ type: "status", phase: "generating" });
    const scenarios = generateScenarios(endpoints);
    state.generatedScenarios = scenarios;

    this.emitScenarioList(scenarios);
  }

  /** Load scenarios from a saved file — skips capture/generate */
  private async loadFromFile(scenarioFile: string): Promise<void> {
    this.emit({ type: "status", phase: "generating" });
    const data = loadScenariosFromFile(scenarioFile);
    state.generatedScenarios = data.scenarios;
    this.emitScenarioList(data.scenarios);
  }

  /** Load scenarios from file and immediately start testing with pre-selected IDs */
  private async loadAndRun(
    scenarioFile: string,
    scenarioIds: string[],
    presets: string[],
    options?: { exploratory?: boolean; cpuProfile?: string },
  ): Promise<void> {
    this.cpuProfile = options?.cpuProfile;
    const data = loadScenariosFromFile(scenarioFile);
    state.generatedScenarios = data.scenarios;
    await this.startTesting(scenarioIds, presets, options);
  }

  /** Emit scenario list and category breakdown to UI */
  private emitScenarioList(scenarios: import("../core/types").Scenario[]): void {
    const items: ScenarioItem[] = scenarios.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      category: s.category,
      endpoint: `${s.endpoint.method} ${s.endpoint.pattern}`,
      priority: s.priority,
      endpointType: s.endpointType,
    }));
    this.emit({ type: "scenarios_list", scenarios: items });
    this.emit({
      type: "scenarios_generated",
      count: scenarios.length,
      byCategory: scenarios.reduce(
        (acc, s) => {
          acc[s.category] = (acc[s.category] ?? 0) + 1;
          return acc;
        },
        {} as Record<string, number>,
      ),
    });
  }

  /** Switch the live screencast to a different worker's page */
  async switchScreencast(workerId: number): Promise<void> {
    if (!this.browser || workerId < 1 || workerId > this.workerPages.length) return;
    const targetPage = this.workerPages[workerId - 1];
    if (!targetPage || targetPage.isClosed()) return;

    await stopScreencast(this.browser.activeCdp);
    this.browser.activeCdp = await startScreencast(targetPage, this.emit);
    this.activeWorkerId = workerId;
    this.emit({ type: "worker_switched", workerId });
  }

  /** Phase 2: Filter to selected scenarios and run parallel agent loops */
  async startTesting(
    scenarioIds: string[],
    presets: string[],
    options?: { exploratory?: boolean; cpuProfile?: string },
  ): Promise<void> {
    try {
      state.generatedScenarios = state.generatedScenarios.filter((s) => scenarioIds.includes(s.id));
      const scenarioNames = state.generatedScenarios.map((s) => s.name);
      const totalItems = scenarioNames.length + presets.length;
      this.estimatedTotal = totalItems;

      const cpuProfile = options?.cpuProfile ?? this.cpuProfile;
      state.testConfig = {
        presets,
        scenarioCount: scenarioNames.length,
        exploratory: options?.exploratory ?? false,
        ...(cpuProfile ? { cpuProfile } : {}),
      };

      if (totalItems === 0 && !options?.exploratory) {
        emitComplete(this.url, this.emit, () => {});
        return;
      }

      const tracker = createFindingTracker(this.emit, this.estimatedTotal);

      // Determine worker count: default 3, override with TREMOR_WORKERS env
      const requested = Math.max(1, parseInt(process.env.TREMOR_WORKERS ?? "3", 10) || 3);
      const numWorkers = totalItems > 0 ? Math.min(requested, totalItems) : 1;

      // Split scenarios and presets across workers via round-robin
      const scenarioChunks = splitIntoChunks(scenarioNames, numWorkers);
      const presetChunks = splitIntoChunks(presets, numWorkers);

      // Create worker pages — worker 0 reuses the main page (keeps CDP screencast)
      if (!state.page || !state.context) {
        throw new Error("No browser open");
      }
      this.workerPages = [state.page];

      // Suppress popup screencast hijacking while creating worker pages
      if (this.browser) this.browser.suppressPopupScreencast = true;
      for (let i = 1; i < numWorkers; i++) {
        const page = await state.context.newPage();
        // Install web vitals tracking and diagnostics on worker pages
        await page.addInitScript(WEB_VITALS_INIT_SCRIPT);
        installDiagnostics(page);
        await page.goto(this.url, { waitUntil: "load", timeout: 30000 });
        this.workerPages.push(page);
      }

      // Notify UI about worker count
      this.emit({ type: "workers_started", count: numWorkers });

      // Apply CPU throttle if a profile was selected
      const cpuRate = cpuProfile ? CPU_PROFILE_RATES[cpuProfile] : undefined;
      if (cpuRate) {
        let mainCdp: CDPSession | null = null;
        for (const page of this.workerPages) {
          const cdp = await page.context().newCDPSession(page);
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
          if (!mainCdp) mainCdp = cdp;
        }
        // Store on state so fault_list and browser cleanup can see it
        state.cpuThrottleRate = cpuRate;
        state.cpuThrottleCdp = mainCdp;
      }

      // Launch all worker agent loops in parallel
      const workerPromises = this.workerPages.map((page, i) => {
        const wIndex = i;
        const workerCtx: WorkerContext = {
          page,
          activeFaults: [],
          targetUrl: this.url,
          onPageChanged: async (oldPage, newPage) => {
            this.workerPages[wIndex] = newPage;
            // Switch screencast to the new page if this is the active worker
            if (this.browser && this.activeWorkerId === wIndex + 1) {
              await stopScreencast(this.browser.activeCdp);
              this.browser.activeCdp = await startScreencast(newPage, this.emit);
            }
          },
        };
        return runAgentLoop({
          url: this.url,
          presets: presetChunks[i] ?? [],
          scenarioNames: scenarioChunks[i] ?? [],
          emit: this.emit,
          stopped: () => this.stopped,
          onFindingAdded: () => tracker.flush(),
          ctx: workerCtx,
          workerId: i + 1,
          exploratory: options?.exploratory,
          cpuThrottleRate: cpuRate,
        });
      });

      await Promise.allSettled(workerPromises);
      if (this.stopped) {
        // Save partial report with findings collected so far
        if (state.findings.length > 0) {
          tracker.flush();
          emitComplete(this.url, this.emit, () => {}, findingRecordings);
        }
        return;
      }

      // Switch back to worker 1 before closing pages if viewing another worker
      if (this.activeWorkerId !== 1 && this.browser && !this.workerPages[0]?.isClosed()) {
        await stopScreencast(this.browser.activeCdp);
        this.browser.activeCdp = await startScreencast(this.workerPages[0]!, this.emit);
        this.activeWorkerId = 1;
      }

      // Close extra worker pages (not the main page — cleanup() handles that)
      for (let i = 1; i < this.workerPages.length; i++) {
        await this.workerPages[i]?.close().catch(() => {});
      }

      emitComplete(this.url, this.emit, () => tracker.flush(), findingRecordings);
    } catch (err) {
      if (!this.stopped) {
        this.emit({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      await this.cleanup();
    }
  }

  isAwaitingAuth(): boolean {
    return this.awaitingAuth;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.awaitingAuth = false;
    await this.cleanup();
  }

  private async cleanup(): Promise<void> {
    // Unroute all fault handlers before closing pages to prevent
    // in-flight route callbacks from throwing on a closed context
    for (const page of this.workerPages) {
      if (!page.isClosed()) {
        await page.unrouteAll({ behavior: "ignoreErrors" }).catch(() => {});
      }
    }
    this.workerPages = [];
    this.activeWorkerId = 1;
    if (this.browser) {
      this.browser.suppressPopupScreencast = false;
      await this.browser.cleanup();
      this.browser = null;
    }
  }
}
