/** Named CPU throttling profiles. Rates are CDP Emulation.setCPUThrottlingRate multipliers. */
export const CPU_PROFILES = {
  "no-throttle": { rate: 1, label: "No throttle (normal)" },
  "mid-tier-mobile": { rate: 2, label: "Mid-tier mobile (2x slowdown)" },
  "low-end-mobile": { rate: 4, label: "Low-end mobile (4x slowdown)" },
  "very-slow-device": { rate: 6, label: "Very slow device (6x slowdown)" },
} as const;

export type CpuProfile = keyof typeof CPU_PROFILES;

export function cpuRateFor(profile: CpuProfile): number {
  return CPU_PROFILES[profile].rate;
}
