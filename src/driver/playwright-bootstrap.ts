import { mkdirSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { chromium, type Browser as PwBrowser } from "playwright";
import { DEFAULT_REDACTION_CONFIG, redactUrl } from "../capture/redaction";
import { createLogger } from "../logging/logger";
import { err, ok, type Result } from "../types/result";
import type { Driver, DriverOptions } from "./driver";
import { PlaywrightDriver, sanitizeBrowserError } from "./playwright";

const log = createLogger("driver:playwright");
export async function createPlaywrightDriver(options: DriverOptions): Promise<Result<Driver>> {
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
