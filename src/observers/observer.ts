import type { Driver } from "../driver/driver";
import type { Observation, ObservationSet } from "../types/observation";
import type { Result } from "../types/result";

export type ObserverContext = {
  driver: Driver;
  url: string;
  /** Skip per-observation screenshots when a caller provides primary evidence. */
  captureEvidence?: boolean;
};

export type Observer = {
  name: string;
  run(ctx: ObserverContext): Promise<Result<Observation[]>>;
};

export async function runObserver(
  observer: Observer,
  ctx: ObserverContext,
): Promise<ObservationSet> {
  const startedAt = Date.now();
  const result = await observer.run(ctx);

  return {
    schemaVersion: 1,
    observer: observer.name,
    url: ctx.url,
    startedAt,
    durationMs: Date.now() - startedAt,
    observations: result.ok ? result.value : [],
    degraded: result.ok ? [] : [{ observer: observer.name, reason: result.error.message }],
  };
}
