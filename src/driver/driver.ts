/**
 * The only browser surface the engine is allowed to touch.
 *
 * Everything above this line (observers, chaos, capture) must go through
 * `Driver`. Nothing above this line may import from "playwright". That keeps
 * the Playwright dependency swappable for a raw-CDP backend later without
 * rewriting the parts that carry Tremor's actual value.
 *
 * Deliberately narrow: each method below maps onto a CDP primitive that a
 * future backend can implement (Page.navigate, Runtime.evaluate,
 * Page.captureScreenshot, Fetch.requestPaused, Network.emulateNetworkConditions,
 * Page.startScreencast).
 */

import type { FaultReceipt } from "../types/chaos";
import type { Evidence } from "../types/observation";
import type { Result } from "../types/result";

export type WaitUntil = "load" | "domcontentloaded" | "networkidle" | "commit";

export type NavigateOptions = {
  waitUntil?: WaitUntil;
  timeoutMs?: number;
};

export type NavigationInfo = {
  url: string;
  status: number | null;
  durationMs: number;
};

export type ScreenshotOptions = {
  label: string;
  fullPage?: boolean;
};

export type NetworkConditions = {
  offline: boolean;
  downloadThroughput: number;
  uploadThroughput: number;
  latencyMs: number;
};

/** A request seen by the driver, before any fault is applied. */
export type InterceptedRequest = {
  method: string;
  url: string;
  resourceType: string;
  headers: Record<string, string>;
  postData: string | null;
};

/** The real response, fetched so a fault can be derived from it. */
export type RealResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

/** What an interceptor decides to do with a request. */
export type InterceptDecisionMeta = { matched?: boolean; scenarioId?: string; faultId?: string };

export type InterceptDecision =
  | ({ action: "continue" } & InterceptDecisionMeta)
  | ({
      action: "fulfill";
      status: number;
      headers: Record<string, string>;
      body: string;
    } & InterceptDecisionMeta)
  | ({
      action: "abort";
      reason: "timedout" | "failed" | "connectionrefused";
    } & InterceptDecisionMeta)
  /** Delay then continue. Kept distinct from fulfill so latency faults stay honest. */
  | ({ action: "delay"; ms: number } & InterceptDecisionMeta)
  /**
   * Fetch the real response, then serve a mutated version of it. Required by
   * corruption scenarios, which nullify fields in the app's actual payload —
   * a synthetic body would not exercise the same parsing path.
   */
  | ({
      action: "transform";
      transform: (real: RealResponse) => RealResponse | Promise<RealResponse>;
    } & InterceptDecisionMeta);

export type Interceptor = (req: InterceptedRequest) => Promise<InterceptDecision>;

export type InterceptOptions = {
  /**
   * Coarse URL glob the backend filters on before invoking the interceptor.
   *
   * Without it every request on the page is round-tripped into Node to be told
   * "continue" — on a request-heavy site under concurrency that stalls the run
   * outright. The interceptor still decides precisely; this only spares it the
   * traffic it could never match. Must therefore err on the side of matching
   * too much.
   */
  urlPattern?: string;
};

/** Handle returned by `intercept`, so callers can remove one fault without a full reset. */
export type InterceptHandle = {
  dispose(): Promise<void>;
};

/** A request/response pair the driver recorded. Feeds endpoint dedup. */
export type RecordedExchange = {
  id: string;
  timestamp: number;
  method: string;
  url: string;
  resourceType: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: string;
    durationMs: number;
  } | null;
};

export type Driver = {
  readonly backend: "playwright" | "cdp";

  navigate(url: string, options?: NavigateOptions): Promise<Result<NavigationInfo>>;
  reload(options?: NavigateOptions): Promise<Result<NavigationInfo>>;
  /** Wait until page traffic has been quiet long enough for async app fetches to settle. */
  waitForIdle(options?: { quietMs?: number; maxMs?: number }): Promise<Result<void>>;
  currentUrl(): string;

  /**
   * Run a function in page context. `fn` is serialised, so it may not close
   * over anything from the Node scope — pass data via `arg`.
   */
  evaluate<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<Result<T>>;

  screenshot(options: ScreenshotOptions): Promise<Result<Evidence>>;

  /** Registers a fault. Multiple interceptors apply in registration order. */
  intercept(interceptor: Interceptor, options?: InterceptOptions): Promise<Result<InterceptHandle>>;
  clearIntercepts(): Promise<Result<void>>;

  emulateNetwork(conditions: NetworkConditions | null): Promise<Result<void>>;
  emulateCpuThrottle(rate: number): Promise<Result<void>>;
  setViewport(width: number, height: number): Promise<Result<void>>;

  /** Start collecting exchanges. Returns everything recorded since the last drain. */
  startRecording(): Promise<Result<void>>;
  /** Stop collecting. Call before close so no body read is left in flight. */
  stopRecording(): Promise<Result<void>>;
  drainExchanges(): RecordedExchange[];
  drainFaultReceipts(): FaultReceipt[];

  /** Console output collected since the driver opened. */
  drainConsole(): Evidence & { kind: "console" };

  /** Path to the session recording, once the session is closed. */
  recordingPath(): Promise<string | null>;

  close(): Promise<void>;
};

export type DriverOptions = {
  url: string;
  headless: boolean;
  /** Output root for videos and screenshots. Must be caller-supplied and
   *  cwd-relative — never derived from import.meta.url, which points at a
   *  read-only virtual fs inside a bun-compiled binary. */
  artifactDir: string;
  viewport: { width: number; height: number };
  timeoutMs: number;
  recordVideo: boolean;
  storageStatePath?: string;
};
