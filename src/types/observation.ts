/**
 * The engine's output unit.
 *
 * An Observation is a *measured fact* plus the evidence that backs it. It
 * deliberately carries no severity, no pass/fail, and no judgement-loaded
 * wording — assigning meaning is the judge's job, and the judge may be the
 * calling agent, an Agent SDK loop, or nothing at all.
 *
 * Rule of thumb when adding a producer: if you find yourself writing
 * `severity: "major"` or a summary like "Broken image", you are judging.
 * State what was measured instead ("img resolved to naturalWidth 0").
 */

export type EvidenceKind = "screenshot" | "video" | "console" | "request" | "trace";

export type Evidence =
  | {
      kind: "screenshot";
      path: string;
      label: string;
      capturedAt: number;
      framing?: "viewport" | "region" | "full-page";
      region?: { x: number; y: number; width: number; height: number };
      byteSize?: number;
    }
  /** `startMs`/`endMs` are offsets into the recording, so a judge can cite a moment. */
  | { kind: "video"; path: string; label: string; startMs: number | null; endMs: number | null }
  | { kind: "console"; entries: ConsoleEntry[] }
  | {
      kind: "request";
      method: string;
      url: string;
      status: number | null;
      durationMs: number | null;
    }
  | { kind: "trace"; path: string; label: string };

export type ConsoleEntry = {
  level: "log" | "info" | "warn" | "error";
  text: string;
  at: number;
};

/**
 * Dotted, namespaced identifier for what was measured — e.g. `dom.overflow`,
 * `net.load-duration`, `chaos.fault-applied`. Judges and report renderers key
 * off this, so treat existing values as a stable contract.
 */
export type ObservationKind = string;

export type Observation = {
  id: string;
  kind: ObservationKind;
  /** Factual, one line, no severity language. */
  summary: string;
  /** The measured values behind `summary`. Judges read this, not the prose. */
  facts: Record<string, unknown>;
  target: {
    selector: string | null;
    url: string | null;
  };
  evidence: Evidence[];
  observedAt: number;
};

/** What the engine emits for one observer run against one page state. */
export type ObservationSet = {
  schemaVersion: 1;
  observer: string;
  url: string;
  startedAt: number;
  durationMs: number;
  observations: Observation[];
  /** Non-fatal problems (a check that could not run). Not findings. */
  degraded: { observer: string; reason: string }[];
};

let counter = 0;

export function createObservation(
  input: Pick<Observation, "kind" | "summary"> & Partial<Observation>,
): Observation {
  return {
    id: `obs-${++counter}`,
    facts: {},
    target: { selector: null, url: null },
    evidence: [],
    observedAt: Date.now(),
    ...input,
  };
}

/** Reset between runs so ids are deterministic per-process. Test seam. */
export function resetObservationIds(): void {
  counter = 0;
}
