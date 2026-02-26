import type { Page } from "playwright";

export type FailedRequest = {
  method: string;
  url: string;
  status: number;
};

export type PageDiagnostic = {
  consoleErrors: string[];
  failedRequests: FailedRequest[];
};

const diagnostics = new Map<Page, PageDiagnostic>();

/** Install console error and failed request listeners on a page */
export function installDiagnostics(page: Page): void {
  const diag: PageDiagnostic = { consoleErrors: [], failedRequests: [] };
  diagnostics.set(page, diag);

  page.on("console", (msg) => {
    if (msg.type() === "error") {
      diag.consoleErrors.push(msg.text());
    }
  });

  page.on("pageerror", (err) => {
    diag.consoleErrors.push(err.message);
  });

  page.on("response", (response) => {
    if (response.status() >= 400) {
      diag.failedRequests.push({
        method: response.request().method(),
        url: response.url(),
        status: response.status(),
      });
    }
  });
}

/** Return current diagnostics for a page */
export function readDiagnostics(page: Page): PageDiagnostic {
  return diagnostics.get(page) ?? { consoleErrors: [], failedRequests: [] };
}

/** Reset diagnostics arrays for fresh capture */
export function clearDiagnostics(page: Page): void {
  const diag = diagnostics.get(page);
  if (diag) {
    diag.consoleErrors = [];
    diag.failedRequests = [];
  }
}
