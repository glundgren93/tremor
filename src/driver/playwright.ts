/**
 * Playwright backend for `Driver`.
 *
 * This is the ONLY file in the engine allowed to import from "playwright".
 * If you need a new browser capability, add it to the `Driver` interface
 * first, then implement it here — do not reach for the Page object upstream.
 */

import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type {
  BrowserContext,
  CDPSession,
  Page,
  Browser as PwBrowser,
  Request,
  Route,
} from "playwright";
import { chromium } from "playwright";
import {
  DEFAULT_REDACTION_CONFIG,
  redactBody,
  redactHeaders,
  redactResponseBody,
  redactUrl,
} from "../capture/redaction";
import { JourneyError } from "../journey";
import { createLogger } from "../logging/logger";
import type { FaultReceipt } from "../types/chaos";
import type { ConsoleEntry, Evidence } from "../types/observation";
import { err, ok, type Result, tryCatch } from "../types/result";
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

const log = createLogger("driver:playwright");

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
const BODY_CONTENT_TYPES = /(json|xml|javascript\+json|text\/plain)/i;

export async function createPlaywrightDriver(options: DriverOptions): Promise<Result<Driver>> {
  // Resolved against cwd on purpose: inside a bun-compiled binary the module
  // URL points at a read-only virtual fs (/$bunfs), so module-relative paths
  // fail with EROFS.
  const artifactDir = isAbsolute(options.artifactDir)
    ? options.artifactDir
    : resolve(process.cwd(), options.artifactDir);

  let browser: PwBrowser | null = null;
  try {
    mkdirSync(artifactDir, { recursive: true });

    browser = await chromium.launch({
      headless: options.headless,
      channel: "chrome",
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
    });

    const context = await browser.newContext({
      viewport: options.viewport,
      storageState: options.storageStatePath,
      serviceWorkers: "block",
      ...(options.recordVideo
        ? { recordVideo: { dir: join(artifactDir, "video"), size: options.viewport } }
        : {}),
    });
    context.setDefaultTimeout(options.timeoutMs);

    const page = await context.newPage();
    const driver = new PlaywrightDriver(browser, context, page, artifactDir, options);
    driver.attachListeners();

    log.info(
      { url: redactUrl(options.url, DEFAULT_REDACTION_CONFIG), headless: options.headless },
      "driver ready",
    );
    return ok(driver);
  } catch (e) {
    await browser?.close().catch(() => {});
    return err(
      e instanceof Error ? sanitizeBrowserError(e, options.storageStatePath) : new Error(String(e)),
    );
  }
}

class PlaywrightDriver implements Driver {
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

    this.page.on("response", async (res) => {
      if (!this.recording || this.closed) return;
      const req = res.request();
      const tracked = this.pending.get(req);
      this.pending.delete(req);

      // Body reads race with navigation; a failed read is normal, not an error.
      let body = "";
      const contentType = res.headers()["content-type"] ?? "";
      if (!this.closed && BODY_CONTENT_TYPES.test(contentType)) {
        try {
          const buf = await res.body();
          body = redactResponseBody(buf.toString("utf8"), contentType) ?? "";
        } catch {
          body = "";
        }
      }

      let requestHeaders = req.headers();
      try {
        // Fetch Metadata and framework prefetch headers are omitted from the
        // synchronous subset but are required for safe same-site targeting.
        requestHeaders = await req.allHeaders();
      } catch {
        // The request may disappear during navigation; fail closed later when
        // cross-origin party metadata is absent.
      }

      // Redact at capture, not at render: stdout is piped straight to an agent
      // and every recorded exchange can reach a report file on disk.
      this.exchanges.push({
        id: tracked?.id ?? `xchg-${++this.nextExchangeId}`,
        timestamp: tracked?.start ?? Date.now(),
        method: req.method(),
        url: redactUrl(req.url(), DEFAULT_REDACTION_CONFIG),
        resourceType: req.resourceType(),
        requestHeaders: redactHeaders(requestHeaders, DEFAULT_REDACTION_CONFIG),
        requestBody: redactBody(req.postData(), requestHeaders["content-type"] ?? "") ?? "",
        response: {
          status: res.status(),
          statusText: res.statusText(),
          headers: redactHeaders(res.headers(), DEFAULT_REDACTION_CONFIG),
          body,
          durationMs: tracked ? Date.now() - tracked.start : 0,
        },
      });
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
      const name = `${String(++this.screenshotCount).padStart(3, "0")}-${slug(opts.label)}.png`;
      const path = join(this.artifactDir, name);
      await this.page.screenshot({ path, fullPage: opts.fullPage ?? false });
      return {
        kind: "screenshot" as const,
        path,
        label: opts.label,
        capturedAt: Date.now(),
      };
    });
  }

  async intercept(
    interceptor: Interceptor,
    options?: InterceptOptions,
  ): Promise<Result<InterceptHandle>> {
    // One Playwright route per interceptor, scoped to its own glob, so the
    // browser filters traffic instead of the Node process.
    const pattern = options?.urlPattern ?? "**/*";
    const handler = (route: Route) => this.handleRoute(route, interceptor);

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

  private async handleRoute(route: Route, interceptor: Interceptor): Promise<void> {
    const request = route.request();
    const intercepted = {
      method: request.method(),
      url: request.url(),
      resourceType: request.resourceType(),
      headers: request.headers(),
      postData: request.postData(),
    };

    let decision: InterceptDecision = { action: "continue" };
    try {
      decision = await interceptor(intercepted);
    } catch (e) {
      this.receipt(
        intercepted,
        { action: "abort", reason: "failed", faultId: "unknown" },
        "error",
        String(e),
      );
      await route.abort("failed").catch(() => {});
      return;
    }
    if (!decision.suppressReceipt)
      this.receipt(intercepted, decision, decision.matched ? "matched" : "pass-through");

    try {
      // Decisions are untrusted at this boundary: never hand an invalid wait to setTimeout.
      const preDelayMs = decision.preDelayMs;
      if (Number.isFinite(preDelayMs) && preDelayMs !== undefined && preDelayMs > 0)
        await sleep(preDelayMs);
      switch (decision.action) {
        case "fulfill":
          await route.fulfill({
            status: decision.status,
            headers: decision.headers,
            body: decision.body,
          });
          if (decision.matched && !decision.suppressReceipt)
            this.receipt(intercepted, decision, "applied");
          return;
        case "abort":
          await route.abort(decision.reason);
          if (decision.matched && !decision.suppressReceipt)
            this.receipt(intercepted, decision, "applied");
          return;
        case "delay":
          await sleep(decision.ms);
          await route.fallback();
          if (decision.matched && !decision.suppressReceipt)
            this.receipt(intercepted, decision, "applied");
          return;
        case "transform": {
          const real = await route.fetch();
          const mutated = await decision.transform({
            status: real.status(),
            headers: real.headers(),
            body: await real.text(),
          });
          await route.fulfill({
            status: mutated.status,
            headers: mutated.headers,
            body: mutated.body,
          });
          if (decision.matched && !decision.suppressReceipt)
            this.receipt(intercepted, decision, "applied");
          return;
        }
        default:
          // Playwright invokes later routes first. Fallback composes this
          // pass-through with earlier guards rather than bypassing them.
          await route.fallback();
      }
    } catch (e) {
      if (!decision.suppressReceipt) this.receipt(intercepted, decision, "error", String(e));
      await route.abort("failed").catch(() => {});
    }
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
    this.faultReceipts.push({
      version: 1,
      status,
      scenarioId: decision.scenarioId ?? "unknown",
      faultId: decision.faultId ?? decision.action,
      method: req.method,
      url: redactUrl(req.url, DEFAULT_REDACTION_CONFIG),
      resourceType: req.resourceType,
      action: decision.action,
      httpStatus: "status" in decision ? decision.status : undefined,
      ...((decision.action === "delay" || decision.preDelayMs !== undefined) &&
      decision.delayKind !== undefined &&
      decision.delayKind !== "mixed"
        ? {
            faultType: decision.delayKind,
            delayMs: decision.action === "delay" ? decision.ms : decision.preDelayMs,
          }
        : decision.action === "delay" || decision.preDelayMs !== undefined
          ? { delayMs: decision.action === "delay" ? decision.ms : decision.preDelayMs }
          : {}),
      timestamp: Date.now(),
      ...(error ? { error } : {}),
    });
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

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "shot"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
