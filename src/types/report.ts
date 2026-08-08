import type { FindingSeverity, SkillFinding, SkillResult } from "./skill";

export type SeverityCounts = Record<FindingSeverity, number>;

export type ReportSummary = {
  url: string;
  timestamp: number;
  totalDurationMs: number;
  skillsRun: number;
  skillsPassed: number;
  skillsFailed: number;
  totalFindings: number;
  severityCounts: SeverityCounts;
  passed: boolean;
};

export type ProofArtifact = {
  skill: string;
  type: "video" | "screenshot";
  path: string;
};

export type TremorReport = {
  version: "1.0.0";
  summary: ReportSummary;
  skills: SkillResult[];
  findings: SkillFinding[];
  proofArtifacts: ProofArtifact[];
};
