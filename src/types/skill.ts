export type FindingSeverity = "critical" | "major" | "minor" | "info";

export type SkillFinding = {
  id: string;
  title: string;
  description: string;
  severity: FindingSeverity;
  screenshotPath: string | null;
  element: string | null;
  metadata: Record<string, unknown>;
};

export type SkillResult = {
  skill: string;
  url: string;
  timestamp: number;
  durationMs: number;
  findings: SkillFinding[];
  videoPath: string | null;
  passed: boolean;
};

let nextId = 0;
export function createFinding(overrides: Partial<SkillFinding> & { title: string }): SkillFinding {
  return {
    id: `finding-${++nextId}`,
    description: "",
    severity: "minor",
    screenshotPath: null,
    element: null,
    metadata: {},
    ...overrides,
  };
}
