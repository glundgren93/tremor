/** Stable, deterministic identifier from canonical input. */
export function stableId(input: string, seed = "tremor-default-seed"): string {
  let h = 2166136261;
  for (const c of `${seed}:${input}`) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return `scn-${(h >>> 0).toString(16).padStart(8, "0")}`;
}

/** Seeded PRNG (mulberry32), intentionally independent of wall clock/randomness. */
export function seededRandom(seed: string | number): () => number {
  let state = typeof seed === "number" ? seed >>> 0 : hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashSeed(seed: string): number {
  let h = 2166136261;
  for (const c of seed) {
    h ^= c.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Legacy nondeterministic IDs retained for diagnostics only. */
export function generateId(): string {
  return stableId(`${Date.now()}:${Math.random()}`);
}
