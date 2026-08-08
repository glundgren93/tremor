/**
 * Content state — what the page is actually showing.
 *
 * The visual observer measures geometry, which is blind to the failure mode
 * that matters most under a fault: the app renders, the layout is fine, and
 * the data is simply gone. A 500 on the task list produced zero geometric
 * change on the benchmark app while the page fell back to the text "error".
 *
 * So this captures a fingerprint of the rendered page rather than emitting
 * observations directly, and the prober diffs baseline against faulted. A
 * fingerprint alone says nothing; the difference between two says everything.
 */

import type { Driver } from "../driver/driver";
import { createObservation, type Observation } from "../types/observation";
import { err, ok, type Result } from "../types/result";

export type ContentState = {
  visibleTextLength: number;
  textSample: string;
  elementCount: number;
  headings: string[];
  /** Text nodes that read like a failure surfaced to the user. */
  errorPhrases: string[];
  /** Elements conventionally used for loading state, still present. */
  spinnerCount: number;
  imageCount: number;
  linkCount: number;
  title: string;
};

/** Fractional drop in visible text that counts as content loss rather than churn. */
const TEXT_LOSS_RATIO = 0.2;

export async function captureContentState(driver: Driver): Promise<Result<ContentState>> {
  const probed = await driver.evaluate(collectContentState);
  return probed.ok ? ok(probed.value) : err(probed.error);
}

/**
 * Compare two content states and describe what changed. Facts only — whether
 * losing 90% of the page is acceptable is not a question the engine answers.
 */
export function diffContent(baseline: ContentState, faulted: ContentState): Observation[] {
  const out: Observation[] = [];

  const lost = baseline.visibleTextLength - faulted.visibleTextLength;
  if (baseline.visibleTextLength > 0 && lost / baseline.visibleTextLength >= TEXT_LOSS_RATIO) {
    out.push(
      createObservation({
        kind: "content.text-lost",
        summary: `Visible text fell from ${baseline.visibleTextLength} to ${faulted.visibleTextLength} characters (${Math.round((lost / baseline.visibleTextLength) * 100)}% gone)`,
        facts: {
          baselineChars: baseline.visibleTextLength,
          faultedChars: faulted.visibleTextLength,
          percentLost: Math.round((lost / baseline.visibleTextLength) * 100),
          faultedSample: faulted.textSample,
        },
        target: { selector: "body", url: null },
      }),
    );
  }

  const newPhrases = faulted.errorPhrases.filter((p) => !baseline.errorPhrases.includes(p));
  if (newPhrases.length > 0) {
    out.push(
      createObservation({
        kind: "content.error-text-appeared",
        summary: `Error text appeared that was not present before: ${newPhrases.slice(0, 3).join(" | ")}`,
        facts: { phrases: newPhrases.slice(0, 5), baselinePhrases: baseline.errorPhrases.length },
        target: { selector: "body", url: null },
      }),
    );
  }

  // No error text *and* no content loss is the silent-failure case: the app
  // swallowed the fault and showed the user nothing.
  if (newPhrases.length === 0 && lost <= 0 && faulted.visibleTextLength > 0) {
    const missing = baseline.headings.filter((h) => !faulted.headings.includes(h));
    if (missing.length > 0) {
      out.push(
        createObservation({
          kind: "content.section-missing",
          summary: `Sections disappeared with no error shown: ${missing.slice(0, 3).join(", ")}`,
          facts: { missingHeadings: missing.slice(0, 5) },
          target: { selector: "body", url: null },
        }),
      );
    }
  }

  if (faulted.spinnerCount > baseline.spinnerCount) {
    out.push(
      createObservation({
        kind: "content.spinner-persisted",
        summary: `${faulted.spinnerCount} loading indicators still present after load (baseline had ${baseline.spinnerCount})`,
        facts: { baseline: baseline.spinnerCount, faulted: faulted.spinnerCount },
        target: { selector: "body", url: null },
      }),
    );
  }

  const elementDrop = baseline.elementCount - faulted.elementCount;
  if (baseline.elementCount > 0 && elementDrop / baseline.elementCount >= TEXT_LOSS_RATIO) {
    out.push(
      createObservation({
        kind: "content.elements-lost",
        summary: `DOM shrank from ${baseline.elementCount} to ${faulted.elementCount} elements`,
        facts: { baseline: baseline.elementCount, faulted: faulted.elementCount },
        target: { selector: "body", url: null },
      }),
    );
  }

  if (baseline.title !== faulted.title) {
    out.push(
      createObservation({
        kind: "content.title-changed",
        summary: `Document title changed from "${baseline.title}" to "${faulted.title}"`,
        facts: { baseline: baseline.title, faulted: faulted.title },
        target: { selector: "title", url: null },
      }),
    );
  }

  return out;
}

/** Runs in page context — self-contained, no imports or closures. */
function collectContentState(): ContentState {
  const ERROR_PATTERNS =
    /(?:\b(error|failed|failure|unavailable|went wrong|try again|retry|not found|unauthori[sz]ed|forbidden|timed? ?out|offline|problem|oops|unable to)\b|\b(erro|falhou|indisponível|tente novamente|não foi possível|algo deu errado)\b|\b(error|falló|no disponible|inténtalo de nuevo|no se pudo|algo salió mal)\b|\b(erreur|indisponible|réessayez|impossible)\b|\b(fehler|nicht verfügbar|erneut versuchen)\b)/iu;
  const SPINNER_SELECTOR =
    '[class*="spinner" i],[class*="loading" i],[class*="skeleton" i],[role="progressbar"],[aria-busy="true"]';

  const body = document.body;
  const visibleText = (body?.innerText ?? "").replace(/\s+/g, " ").trim();

  const errorPhrases: string[] = [];
  const walker = document.createTreeWalker(body ?? document, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && errorPhrases.length < 20; node = walker.nextNode()) {
    const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
    if (text.length > 0 && text.length < 200 && ERROR_PATTERNS.test(text)) {
      const parent = node.parentElement;
      // Hidden error templates are shipped by many apps; only rendered text counts.
      if (parent && parent.getBoundingClientRect().height > 0)
        errorPhrases.push(text.slice(0, 120));
    }
  }

  return {
    visibleTextLength: visibleText.length,
    textSample: visibleText.slice(0, 200),
    elementCount: document.querySelectorAll("*").length,
    headings: Array.from(document.querySelectorAll("h1,h2,h3"))
      .map((h) => (h.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((t) => t.length > 0)
      .slice(0, 25),
    errorPhrases,
    spinnerCount: document.querySelectorAll(SPINNER_SELECTOR).length,
    imageCount: document.querySelectorAll("img").length,
    linkCount: document.querySelectorAll("a").length,
    title: document.title,
  };
}
