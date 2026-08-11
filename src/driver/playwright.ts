/**
 * Playwright backend for `Driver`.
 *
 * This is the ONLY file in the engine allowed to import from "playwright".
 * If you need a new browser capability, add it to the `Driver` interface
 * first, then implement it here — do not reach for the Page object upstream.
 */

import type {
  BrowserContext,
  CDPSession,
  Page,
  Browser as PwBrowser,
  Request,
  Route,
} from "playwright";
import { JourneyError } from "../journey";
import type { FaultReceipt } from "../types/chaos";
import type { ConsoleEntry, Evidence } from "../types/observation";
import { ok, type Result, tryCatch } from "../types/result";
import type {
  ActionTarget,
  Driver,
  DriverOptions,
  InterceptDecision,
  InterceptedRequest,
  InterceptHandle,
  InterceptOptions,
  Interceptor,
  NavigateOptions,
  NavigationInfo,
  NetworkConditions,
  RecordedExchange,
  ScreenshotOptions,
} from "./driver";
import { recordResponse } from "./playwright-recording";
import { createFaultReceipt, createRouteHandler } from "./playwright-routes";
import { writeAtomicScreenshot } from "./playwright-screenshot";

export { createPlaywrightDriver } from "./playwright-bootstrap";
export { writeAtomicScreenshot } from "./playwright-screenshot";

export function sanitizeBrowserError(error: Error, storageStatePath?: string): Error {
  const message = storageStatePath
    ? error.message.replaceAll(storageStatePath, "<auth-state>")
    : error.message;
  return new Error(message);
}

/** Response bodies above this are truncated — they exist to seed fault payloads, not for storage. */

/**
 * Only these content types have their body read.
 *
 * Bodies exist to classify endpoints and seed corruption mutations, so scripts,
 * images and stylesheets have nothing to offer. Reading them all is also what
 * wedged runs on request-heavy sites: ~250 concurrent `body()` reads that are
 * still in flight when the context closes never settle, and they pin the
 * process well past every timeout.
 */
const _BODY_CONTENT_TYPES = /(json|xml|javascript\+json|text\/plain)/i;

export class PlaywrightDriver implements Driver {
  readonly backend = "playwright" as const;

  private readonly routes: { pattern: string; handler: (route: Route) => void }[] = [];

  private readonly exchanges: RecordedExchange[] = [];
  private readonly faultReceipts: FaultReceipt[] = [];
  private readonly consoleEntries: ConsoleEntry[] = [];
  private readonly pending = new Map<Request, { start: number; id: string }>();
  private readonly inFlight = new Set<Request>();
  private lastNetworkActivity = Date.now();
  private nextExchangeId = 0;
  private cdp: CDPSession | null = null;
  private recording = false;
  private screenshotCount = 0;
  private closed = false;

  constructor(
    private readonly browser: PwBrowser,
    private readonly context: BrowserContext,
    private readonly page: Page,
    private readonly artifactDir: string,
    private readonly options: DriverOptions,
  ) {}

  attachListeners(): void {
    this.page.on("console", (msg) => {
      const type = msg.type();
      const level: ConsoleEntry["level"] =
        type === "error" ? "error" : type === "warning" ? "warn" : type === "info" ? "info" : "log";
      this.consoleEntries.push({ level, text: msg.text(), at: Date.now() });
    });

    this.page.on("pageerror", (error) => {
      this.consoleEntries.push({ level: "error", text: error.message, at: Date.now() });
    });

    this.page.on("request", (req) => {
      this.inFlight.add(req);
      this.lastNetworkActivity = Date.now();
      if (!this.recording) return;
      this.pending.set(req, {
        start: Date.now(),
        id: `xchg-${++this.nextExchangeId}`,
      });
    });

    const finishRequest = (req: Request) => {
      this.inFlight.delete(req);
      this.lastNetworkActivity = Date.now();
    };
    this.page.on("requestfinished", finishRequest);
    this.page.on("requestfailed", finishRequest);

    this.page.on("response", (res) => {
      if (this.recording && !this.closed) void this.recordResponse(res);
    });
  }

  private async recordResponse(res: import("playwright").Response): Promise<void> {
    await recordResponse(res, {
      recording: this.recording,
      closed: this.closed,
      pending: this.pending,
      nextId: () => ++this.nextExchangeId,
      exchanges: this.exchanges,
    });
  }

  currentUrl(): string {
    return this.page.url();
  }

  private locator(target: ActionTarget) {
    if (target.testId) return this.page.getByTestId(target.testId);
    if (target.label) return this.page.getByLabel(target.label, { exact: true });
    if (target.role)
      return this.page.getByRole(
        target.role as Parameters<Page["getByRole"]>[0],
        target.name ? { name: target.name, exact: true } : undefined,
      );
    return null;
  }

  async click(target: ActionTarget): Promise<Result<void>> {
    return tryCatch(async () => {
      const locator = this.locator(target);
      if (!locator || (await locator.count()) !== 1 || !(await locator.isVisible()))
        throw new JourneyError("ambiguous-target", undefined, "target");
      const unsafeSubmit = await locator.evaluate((element) => {
        if (element instanceof HTMLInputElement) return element.type.toLowerCase() === "submit";
        if (element instanceof HTMLButtonElement) return element.type.toLowerCase() === "submit";
        return false;
      });
      if (unsafeSubmit) throw new JourneyError("unsafe-request-blocked", undefined, "click");
      await locator.click();
    });
  }

  async fill(target: ActionTarget & { value: string }): Promise<Result<void>> {
    return tryCatch(async () => {
      const locator = this.locator(target);
      if (!locator || (await locator.count()) !== 1 || !(await locator.isVisible()))
        throw new JourneyError("ambiguous-target", undefined, "target");
      await locator.fill(target.value);
    });
  }

  async waitForVisible(target: ActionTarget): Promise<Result<void>> {
    return tryCatch(async () => {
      const locator = this.locator(target);
      if (!locator || (await locator.count()) !== 1)
        throw new Error("journey target was not exactly one visible element");
      await locator.waitFor({ state: "visible" });
    });
  }

  async installJourneySafetyGuard(): Promise<Result<InterceptHandle>> {
    let blocked = false;
    let blockedNavigation = false;
    const authorized = new Set<string>();
    const installed = await this.intercept(async (req) => {
      if (req.resourceType === "document") {
        const exact = new URL(req.url).href;
        if (req.method.toUpperCase() === "GET" && authorized.delete(exact))
          return { action: "continue", suppressReceipt: true };
        blocked = true;
        blockedNavigation = true;
        return { action: "abort", reason: "failed", suppressReceipt: true };
      }
      const method = req.method.toUpperCase();
      if (method === "GET" || method === "HEAD" || method === "OPTIONS")
        return { action: "continue", suppressReceipt: true };
      blocked = true;
      return { action: "abort", reason: "failed", suppressReceipt: true };
    });
    if (!installed.ok) return installed;
    const inner = installed.value;
    return ok({
      dispose: () => inner.dispose(),
      authorizeNavigation: (url) => authorized.add(new URL(url).href),
      get blocked() {
        return blocked;
      },
      get blockedNavigation() {
        return blockedNavigation;
      },
    });
  }

  async navigate(url: string, opts?: NavigateOptions): Promise<Result<NavigationInfo>> {
    return tryCatch(async () => {
      const start = Date.now();
      const response = await this.page.goto(url, {
        waitUntil: opts?.waitUntil ?? "load",
        timeout: opts?.timeoutMs ?? this.options.timeoutMs,
      });
      return {
        url: this.page.url(),
        status: response?.status() ?? null,
        durationMs: Date.now() - start,
      };
    });
  }

  async reload(opts?: NavigateOptions): Promise<Result<NavigationInfo>> {
    return tryCatch(async () => {
      const start = Date.now();
      const response = await this.page.reload({
        waitUntil: opts?.waitUntil ?? "load",
        timeout: opts?.timeoutMs ?? this.options.timeoutMs,
      });
      return {
        url: this.page.url(),
        status: response?.status() ?? null,
        durationMs: Date.now() - start,
      };
    });
  }

  async waitForIdle(options?: { quietMs?: number; maxMs?: number }): Promise<Result<void>> {
    return tryCatch(async () => {
      const quietMs = options?.quietMs ?? 300;
      const deadline = Date.now() + (options?.maxMs ?? 3_000);
      while (Date.now() < deadline) {
        if (this.inFlight.size === 0 && Date.now() - this.lastNetworkActivity >= quietMs) return;
        await sleep(50);
      }
    });
  }

  async evaluate<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<Result<T>> {
    // Playwright's Unboxed<A> mapping can't be expressed through our generic
    // signature; the cast is contained to this one call.
    const pageFunction = fn as unknown as (arg: unknown) => T;
    return tryCatch(() => this.page.evaluate<T, unknown>(pageFunction, arg));
  }

  async screenshot(opts: ScreenshotOptions): Promise<Result<Evidence>> {
    return tryCatch(async () => {
      const written = await writeAtomicScreenshot(
        this.page,
        this.artifactDir,
        this.screenshotCount,
        opts,
      );
      this.screenshotCount = written.count;
      return written.evidence;
    });
  }

  async intercept(
    interceptor: Interceptor,
    options?: InterceptOptions,
  ): Promise<Result<InterceptHandle>> {
    // One Playwright route per interceptor, scoped to its own glob, so the
    // browser filters traffic instead of the Node process.
    const pattern = options?.urlPattern ?? "**/*";
    const handler = createRouteHandler(interceptor, (req, decision, status, error) =>
      this.receipt(req, decision, status, error),
    );

    const installed = await tryCatch(() => this.context.route(pattern, handler));
    if (!installed.ok) return installed;
    this.routes.push({ pattern, handler });

    return ok({
      dispose: async () => {
        await this.context.unroute(pattern, handler).catch(() => {});
        const i = this.routes.findIndex((r) => r.handler === handler);
        if (i >= 0) this.routes.splice(i, 1);
      },
    });
  }

  async clearIntercepts(): Promise<Result<void>> {
    const routes = this.routes.splice(0, this.routes.length);
    return tryCatch(async () => {
      for (const { pattern, handler } of routes) {
        await this.context.unroute(pattern, handler).catch(() => {});
      }
    });
  }

  /**
   * One long-lived CDP session for all emulation.
   *
   * Emulation overrides are scoped to the session that set them and are
   * reverted the moment it detaches — verified: setting `offline: true` then
   * detaching lets the very next navigation succeed. So the session must stay
   * attached for the lifetime of the driver.
   */
  private async emulationSession(): Promise<CDPSession> {
    if (!this.cdp) {
      this.cdp = await this.context.newCDPSession(this.page);
      await this.cdp.send("Network.enable");
    }
    return this.cdp;
  }

  async emulateNetwork(conditions: NetworkConditions | null): Promise<Result<void>> {
    return tryCatch(async () => {
      const cdp = await this.emulationSession();
      await cdp.send("Network.emulateNetworkConditions", {
        offline: conditions?.offline ?? false,
        // -1 disables the override rather than throttling to zero.
        downloadThroughput: conditions?.downloadThroughput ?? -1,
        uploadThroughput: conditions?.uploadThroughput ?? -1,
        latency: conditions?.latencyMs ?? 0,
      });
    });
  }

  async emulateCpuThrottle(rate: number): Promise<Result<void>> {
    return tryCatch(async () => {
      const cdp = await this.emulationSession();
      await cdp.send("Emulation.setCPUThrottlingRate", { rate });
    });
  }

  async setViewport(width: number, height: number): Promise<Result<void>> {
    return tryCatch(() => this.page.setViewportSize({ width, height }));
  }

  async startRecording(): Promise<Result<void>> {
    this.recording = true;
    return ok(undefined);
  }

  async stopRecording(): Promise<Result<void>> {
    this.recording = false;
    return ok(undefined);
  }

  drainFaultReceipts(): FaultReceipt[] {
    return this.faultReceipts.splice(0, this.faultReceipts.length);
  }

  private receipt(
    req: InterceptedRequest,
    decision: InterceptDecision,
    status: FaultReceipt["status"],
    error?: string,
  ): void {
    this.faultReceipts.push(createFaultReceipt(req, decision, status, error));
  }

  drainExchanges(): RecordedExchange[] {
    return this.exchanges.splice(0, this.exchanges.length);
  }

  drainConsole(): Evidence & { kind: "console" } {
    return { kind: "console", entries: this.consoleEntries.splice(0, this.consoleEntries.length) };
  }

  /** Only resolvable after the context closes — Playwright flushes the webm on close. */
  async recordingPath(): Promise<string | null> {
    if (!this.options.recordVideo) return null;
    try {
      const video = this.page.video();
      if (!video) return null;
      return await video.path();
    } catch {
      return null;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.context.close().catch(() => {});
    await this.browser.close().catch(() => {});
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
