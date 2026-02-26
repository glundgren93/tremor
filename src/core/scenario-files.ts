import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Scenario, ScenarioFile } from "./types";

/** Directory for saved scenario files (project-local, committable) */
export function getScenariosDir(): string {
  return join(process.cwd(), ".tremor", "scenarios");
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export function saveScenariosToFile(
  scenarios: Scenario[],
  url: string,
  options?: { name?: string; filter?: string },
): { file: string; count: number } {
  const dir = getScenariosDir();
  ensureDir(dir);

  const timestamp = Date.now();
  const slug = options?.name ? slugify(options.name) : slugify(new URL(url).hostname);
  const filename = `${timestamp}-${slug}.json`;

  const data: ScenarioFile = {
    version: 1,
    url,
    filter: options?.filter,
    savedAt: timestamp,
    scenarios,
  };

  const filePath = join(dir, filename);
  writeFileSync(filePath, JSON.stringify(data, null, 2));
  return { file: filename, count: scenarios.length };
}

export function loadScenariosFromFile(filename: string): ScenarioFile {
  const filePath = join(getScenariosDir(), filename);
  if (!existsSync(filePath)) {
    throw new Error(`Scenario file not found: ${filename}`);
  }
  const raw = readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as ScenarioFile;
}

export type ScenarioFileListItem = {
  file: string;
  url: string;
  filter?: string;
  savedAt: number;
  scenarioCount: number;
};

export function listScenarioFiles(): ScenarioFileListItem[] {
  const dir = getScenariosDir();
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse()
    .map((f) => {
      try {
        const raw = readFileSync(join(dir, f), "utf-8");
        const data = JSON.parse(raw) as ScenarioFile;
        return {
          file: f,
          url: data.url,
          ...(data.filter !== undefined && { filter: data.filter }),
          savedAt: data.savedAt,
          scenarioCount: data.scenarios.length,
        } as ScenarioFileListItem;
      } catch {
        return null;
      }
    })
    .filter((item): item is ScenarioFileListItem => item !== null);
}

export function deleteScenarioFile(filename: string): boolean {
  const filePath = join(getScenariosDir(), filename);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}
