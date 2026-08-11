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

import { createHmac, randomBytes } from "node:crypto";
import type { Driver } from "../driver/driver";
import { err, ok, type Result } from "../types/result";
import type { ContentState } from "./content-state";
import { shortRegionId } from "./regions";

export { changedSemanticRegionKeys, diffContent } from "./content-diff";
export type { ContentState } from "./content-state";

export async function captureContentState(
  driver: Driver,
  fingerprintKey: string = randomBytes(32).toString("hex"),
): Promise<Result<ContentState>> {
  const probed = await driver.evaluate(collectContentState);
  if (!probed.ok) return err(probed.error);
  const hashedKey = (key: string) => shortRegionId(key);
  return ok({
    ...probed.value,
    regions: probed.value.regions?.map((region) => ({
      ...region,
      key: hashedKey(region.key),
      regionId: hashedKey(region.key),
    })),
    regionFingerprints: probed.value.regionFingerprints
      ? Object.fromEntries(
          Object.entries(probed.value.regionFingerprints).map(([key, value]) => [
            hashedKey(key),
            createHmac("sha256", fingerprintKey).update(value).digest("hex"),
          ]),
        )
      : undefined,
    regionTextFingerprints: probed.value.regionTextFingerprints
      ? Object.fromEntries(
          Object.entries(probed.value.regionTextFingerprints).map(([key, value]) => [
            hashedKey(key),
            createHmac("sha256", fingerprintKey).update(value).digest("hex"),
          ]),
        )
      : undefined,
  });
}

/**
 * Compare two content states and describe what changed. Facts only — whether
 * losing 90% of the page is acceptable is not a question the engine answers.
 */
/** Runs in page context — self-contained, no imports or closures. */
function collectContentState(): ContentState {
  const ERROR_PATTERNS =
    /(?:\b(error|failed|failure|unavailable|went wrong|try again|retry|not found|unauthori[sz]ed|forbidden|timed? ?out|offline|problem|oops|unable to|slow response)\b|\b(erro|falhou|indisponível|tente novamente|não foi possível|algo deu errado)\b|\b(error|falló|no disponible|inténtalo de nuevo|no se pudo|algo salió mal)\b|\b(erreur|indisponible|réessayez|impossible)\b|\b(fehler|nicht verfügbar|erneut versuchen)\b)/iu;
  const SPINNER_SELECTOR =
    '[class*="spinner" i],[class*="loading" i],[class*="skeleton" i],[role="progressbar"],[aria-busy="true"]';

  const body = document.body;
  const isEditableText = (node: Node) => {
    const parent = node.parentElement;
    return !!parent?.closest(
      'input,textarea,select,[contenteditable]:not([contenteditable="false"])',
    );
  };
  const safeText = (root: Node) => {
    const parts: string[] = [];
    const textWalker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = textWalker.nextNode(); node; node = textWalker.nextNode()) {
      if (!isEditableText(node)) parts.push(node.textContent ?? "");
    }
    return parts.join(" ").replace(/\s+/g, " ").trim();
  };
  const visibleText = safeText(body ?? document);

  const findErrorPhrases = () => {
    const phrases: string[] = [];
    const walker = document.createTreeWalker(body ?? document, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && phrases.length < 20; node = walker.nextNode()) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      const parent = node.parentElement;
      if (
        !isEditableText(node) &&
        text.length > 0 &&
        text.length < 200 &&
        ERROR_PATTERNS.test(text) &&
        parent?.getBoundingClientRect().height
      )
        phrases.push(text.slice(0, 120));
    }
    return phrases;
  };
  const errorPhrases = findErrorPhrases();

  const regionSelector =
    'main,section,article,form,table,[role="dialog"],[role="main"],[role="region"],[role="navigation"],[role="complementary"],[data-testid],[id]';
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(regionSelector)).slice(
    0,
    100,
  );
  const keyFor = (el: HTMLElement) => {
    const testId = el.getAttribute("data-testid");
    const id = el.id;
    const safe = (value: string | null) =>
      !!value &&
      value.length <= 64 &&
      /^[a-zA-Z][\w.-]*$/.test(value) &&
      !/(?:token|secret|email|https?|[0-9a-f]{8}-[0-9a-f-]{27})/i.test(value);
    if (safe(testId)) return `testid:${testId}`;
    if (safe(id)) return `id:${id}`;
    const parent = el.parentElement;
    if (!parent) return null;
    const siblings = Array.from(parent.children).filter((node) => node.tagName === el.tagName);
    return `${el.tagName.toLowerCase()}:${siblings.indexOf(el)}`;
  };
  const counts: Record<string, number> = {};
  const raw = candidates
    .map((el) => ({ el, key: keyFor(el) }))
    .filter((x): x is { el: HTMLElement; key: string } => !!x.key);
  for (const item of raw) counts[item.key] = (counts[item.key] ?? 0) + 1;
  const viewport = {
    width: window.innerWidth,
    height: window.innerHeight,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
  const regionMetrics = (el: HTMLElement) => {
    const MAX_NODES = 2_000;
    const MAX_CHARS = 10_000;
    const state = {
      text: "",
      rowCount: 0,
      itemCount: 0,
      controlCount: 0,
      errorPhraseCount: 0,
      skeletonCount: 0,
    };
    const ownText = (element: HTMLElement) =>
      Array.from(element.childNodes)
        .filter((child) => child.nodeType === Node.TEXT_NODE && !isEditableText(child))
        .map((child) => child.textContent ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
    const inspect = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        if (!isEditableText(node) && state.text.length < MAX_CHARS)
          state.text += ` ${(node.textContent ?? "").slice(0, MAX_CHARS - state.text.length)}`;
        return;
      }
      const element = node as HTMLElement;
      state.rowCount += Number(element.matches('tr,[role="row"]'));
      state.itemCount += Number(element.matches('li,[role="listitem"]'));
      state.controlCount += Number(
        element.matches(
          'button,input,select,textarea,[role="button"],[role="checkbox"],[role="radio"],[role="textbox"]',
        ),
      );
      state.skeletonCount += Number(element.matches(SPINNER_SELECTOR));
      const text = ownText(element);
      state.errorPhraseCount += Number(
        text.length > 0 && text.length < 200 && ERROR_PATTERNS.test(text),
      );
    };
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (
      let node: Node | null = el, inspected = 0;
      node && inspected < MAX_NODES;
      node = walker.nextNode()
    ) {
      inspected++;
      inspect(node);
    }
    const boundedText = state.text.replace(/\s+/g, " ").trim().slice(0, MAX_CHARS);
    return {
      text: boundedText,
      metrics: {
        textLength: boundedText.length,
        rowCount: Math.min(1000, state.rowCount),
        itemCount: Math.min(1000, state.itemCount),
        controlCount: Math.min(1000, state.controlCount),
        errorPhraseCount: Math.min(100, state.errorPhraseCount),
        skeletonCount: Math.min(100, state.skeletonCount),
        blankCount: boundedText.length === 0 && el.children.length === 0 ? 1 : 0,
      },
    };
  };
  const regionSnapshots = new Map(raw.map(({ el }) => [el, regionMetrics(el)]));
  const regions = raw.map(({ el, key }) => {
    const rect = el.getBoundingClientRect();
    const visibleWidth = Math.max(0, Math.min(rect.right, viewport.width) - Math.max(rect.left, 0));
    const visibleHeight = Math.max(
      0,
      Math.min(rect.bottom, viewport.height) - Math.max(rect.top, 0),
    );
    return {
      key,
      regionId: key,
      kind: el.tagName.toLowerCase(),
      rect: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      },
      viewport,
      visibleRatio:
        rect.width * rect.height ? (visibleWidth * visibleHeight) / (rect.width * rect.height) : 0,
      count: counts[key] ?? 0,
      metrics: regionSnapshots.get(el)?.metrics,
    };
  });
  // These raw values exist only inside the private collector result and are
  // immediately replaced with keyed HMACs before captureContentState returns.
  const regionTextFingerprints = Object.fromEntries(
    raw.map(({ el, key }) => [key, regionSnapshots.get(el)?.text ?? ""]),
  );
  const regionFingerprints = Object.fromEntries(
    regions.map((region) => [
      region.key,
      `${regionTextFingerprints[region.key]}\0${JSON.stringify(region.metrics)}`,
    ]),
  );
  const controls = Array.from(
    document.querySelectorAll<HTMLElement>(
      'button,input,select,textarea,[role="button"],[role="checkbox"],[role="radio"],[role="textbox"]',
    ),
  );
  const controlCounts: Record<string, number> = {
    button: 0,
    checkbox: 0,
    radio: 0,
    select: 0,
    textbox: 0,
  };
  const controlKind = (el: HTMLElement) => {
    const role = el.getAttribute("role");
    const type = (el.getAttribute("type") ?? "").toLowerCase();
    if (role === "checkbox" || type === "checkbox") return "checkbox";
    if (role === "radio" || type === "radio") return "radio";
    if (el.tagName === "SELECT") return "select";
    if (el.tagName === "BUTTON" || role === "button" || type === "button" || type === "submit")
      return "button";
    return "textbox";
  };
  for (const el of controls) {
    const kind = controlKind(el);
    controlCounts[kind] = (controlCounts[kind] ?? 0) + 1;
  }
  const panels = candidates.filter((el) =>
    el.matches('main,section,article,[role="region"],[data-testid]'),
  );

  return {
    visibleTextLength: visibleText.length,
    textSample: visibleText.slice(0, 200),
    elementCount: document.querySelectorAll("*").length,
    headings: Array.from(document.querySelectorAll("h1,h2,h3"))
      .map((h) => safeText(h))
      .filter((t) => t.length > 0)
      .slice(0, 25),
    errorPhrases,
    spinnerCount: document.querySelectorAll(SPINNER_SELECTOR).length,
    imageCount: document.querySelectorAll("img").length,
    linkCount: document.querySelectorAll("a").length,
    title: document.title,
    controlCounts,
    blankPanelCount: panels.filter((el) => !safeText(el) && el.children.length === 0).length,
    skeletonCount: document.querySelectorAll('[class*="skeleton" i],[aria-busy="true"]').length,
    nonemptyControlCount: controls
      .filter(
        (el) =>
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement,
      )
      .filter((el) => !!el.value).length,
    regions,
    regionFingerprints,
    regionTextFingerprints,
  };
}
