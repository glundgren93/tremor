import { renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { Evidence } from "../types/observation";
import type { ScreenshotOptions, ScreenshotRegion } from "./driver";

type ScreenshotPage = {
  screenshot(options: {
    path: string;
    fullPage: boolean;
    clip?: ScreenshotRegion;
  }): Promise<unknown>;
};

/** Atomic screenshot lifecycle, isolated for deterministic failure testing. */
export async function writeAtomicScreenshot(
  page: ScreenshotPage,
  artifactDir: string,
  count: number,
  opts: ScreenshotOptions,
): Promise<{ evidence: Evidence; count: number }> {
  validateScreenshotOptions(opts);
  const next = count + 1;
  const path = join(artifactDir, `${String(next).padStart(3, "0")}-${slug(opts.label)}.png`);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}.png`;
  try {
    await page.screenshot({
      path: temporary,
      fullPage: opts.fullPage ?? false,
      ...(opts.region ? { clip: opts.region } : {}),
    });
    renameSync(temporary, path);
  } catch (error) {
    removeScreenshotFiles(temporary, path);
    throw error;
  }
  return {
    count: next,
    evidence: {
      kind: "screenshot",
      path,
      label: opts.label,
      capturedAt: Date.now(),
      framing: opts.region ? "region" : opts.fullPage ? "full-page" : "viewport",
      ...(opts.region ? { region: opts.region } : {}),
      byteSize: statSync(path).size,
    },
  };
}

export function validateScreenshotOptions(opts: ScreenshotOptions): void {
  if (opts.region && opts.fullPage)
    throw new Error("screenshot region and fullPage are mutually exclusive");
  if (
    opts.region &&
    (!Object.values(opts.region).every(Number.isFinite) ||
      opts.region.width <= 0 ||
      opts.region.height <= 0)
  )
    throw new Error("invalid screenshot region");
}

function removeScreenshotFiles(...paths: string[]): void {
  for (const path of paths) {
    try {
      unlinkSync(path);
    } catch {}
  }
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "shot"
  );
}
