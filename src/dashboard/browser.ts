import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, CDPSession, Page } from "playwright";
import { generateId } from "../core/id";
import { installDiagnostics } from "../core/page-diagnostics";
import { DEFAULT_REDACTION_CONFIG } from "../core/redaction";
import type { CapturedRequest, HttpMethod } from "../core/types";
import { WEB_VITALS_INIT_SCRIPT } from "../core/web-vitals";
import { state } from "../state";
import { findingRecordings, findingScreenshots } from "../tools/report";
import { importPlaywright } from "./playwright-import";
import type { ServerMessage } from "./protocol";

export interface BrowserSession {
  context: BrowserContext;
  page: Page;
  activeCdp: CDPSession;
  suppressPopupScreencast: boolean;
  recordingsDir: string;
  cleanup(): Promise<void>;
}

export async function launchBrowser(
  url: string,
  emit: (msg: ServerMessage) => void,
  stopped: () => boolean,
): Promise<BrowserSession | null> {
  // 1. Launch browser
  emit({ type: "status", phase: "launching" });
  const { chromium } = await importPlaywright();
  const browser = await chromium.launch({
    headless: true,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const recordingsDir = mkdtempSync(join(tmpdir(), 'tremor-recordings-'));
  const context = await browser.newContext({
    recordVideo: { dir: recordingsDir, size: { width: 1280, height: 720 } },
  });
  const mainPage = await context.newPage();
  if (stopped()) return null;

  // 2. Populate state singleton for tool handlers
  state.context = context;
  state.page = mainPage;
  state.capturedRequests = [];
  state.generatedScenarios = [];
  state.activeFaults = [];
  state.findings = [];
  state.recommendations = [];
  findingScreenshots.clear();
  findingRecordings.clear();
  state.redactionConfig = { ...DEFAULT_REDACTION_CONFIG };
  state.cpuThrottleRate = 1;
  state.cpuThrottleCdp = null;

  // 3. Start CDP screencast for live streaming to dashboard
  let activeCdp = await startScreencast(mainPage, emit);

  // Build session object early so popup handler can read suppressPopupScreencast
  const session: BrowserSession = {
    context,
    page: mainPage,
    activeCdp,
    suppressPopupScreencast: false,
    recordingsDir,
    async cleanup() {
      if (state.cpuThrottleCdp) {
        try {
          await state.cpuThrottleCdp.detach();
        } catch {}
        state.cpuThrottleCdp = null;
        state.cpuThrottleRate = 1;
      }
      await stopScreencast(session.activeCdp);
      try {
        await context.close();
      } catch {}
      state.context = null;
      state.page = null;
    },
  };

  // 4. Track popups — switch screencast to popup when opened (e.g. OAuth),
  //    switch back to main page when popup closes.
  context.on("page", async (popup) => {
    if (session.suppressPopupScreencast) return;
    try {
      await popup.waitForLoadState("domcontentloaded");
      await stopScreencast(session.activeCdp);
      session.activeCdp = await startScreencast(popup, emit);
      state.page = popup;

      popup.on("close", async () => {
        if (session.suppressPopupScreencast) return;
        await stopScreencast(session.activeCdp);
        session.activeCdp = await startScreencast(mainPage, emit);
        state.page = mainPage;
      });
    } catch {}
  });

  // 5. Install web vitals tracking
  await context.addInitScript(WEB_VITALS_INIT_SCRIPT);

  // 6. Install request capture and page diagnostics
  installRequestCapture(mainPage);
  installDiagnostics(mainPage);

  // 7. Navigate
  emit({ type: "status", phase: "navigating" });
  await mainPage.goto(url, { waitUntil: "load", timeout: 30000 });
  if (stopped()) return null;

  return session;
}

export async function stopScreencast(cdp: CDPSession): Promise<void> {
  try {
    await cdp.send("Page.stopScreencast");
    await cdp.detach();
  } catch {}
}

export async function startScreencast(
  page: Page,
  emit: (msg: ServerMessage) => void,
  maxWidth = 1280,
  maxHeight = 720,
): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  cdp.on("Page.screencastFrame", (params) => {
    emit({ type: "screenshot", data: params.data });
    cdp.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => {});
  });
  await cdp.send("Page.startScreencast", {
    format: "jpeg",
    quality: 60,
    maxWidth,
    maxHeight,
    everyNthFrame: 1,
  });
  return cdp;
}

function installRequestCapture(page: Page): void {
  page.on("response", async (response) => {
    const request = response.request();
    const method = request.method().toUpperCase() as HttpMethod;
    const resourceType = request.resourceType();
    if (["image", "stylesheet", "font", "media", "manifest"].includes(resourceType)) return;

    let body = "";
    try {
      body = await response.text();
    } catch {}

    const captured: CapturedRequest = {
      id: generateId(),
      timestamp: Date.now(),
      method,
      url: request.url(),
      headers: request.headers(),
      body: request.postData() ?? null,
      response: {
        status: response.status(),
        statusText: response.statusText(),
        headers: response.headers(),
        body,
        duration: 0,
      },
    };
    state.capturedRequests.push(captured);
  });
}
