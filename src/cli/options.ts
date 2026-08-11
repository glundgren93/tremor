import { parseArgs } from "node:util";
import { fail } from "./run-dir";

export function parseCommandArgs(argv: string[], shorthand: boolean): ReturnType<typeof parseArgs> {
  try {
    return parseArgs({
      args: shorthand ? argv : argv.slice(1),
      allowPositionals: true,
      options: {
        out: { type: "string", default: "tremor-runs" },
        filter: { type: "string" },
        routes: { type: "string" },
        preset: { type: "string", multiple: true, default: [] },
        fault: { type: "string" },
        wait: { type: "string", default: "load" },
        timeout: { type: "string", default: "30000" },
        viewport: { type: "string", default: "1280x720" },
        cpu: { type: "string" },
        category: { type: "string", multiple: true, default: [] },
        scenarios: { type: "string" },
        budget: { type: "string", default: "3" },
        "proof-limit": { type: "string", default: "2" },
        concurrency: { type: "string", default: "4" },
        "auth-state": { type: "string" },
        profile: { type: "string" },
        journey: { type: "string" },
        seed: { type: "string", default: "tremor-default-seed" },
        headed: { type: "boolean", default: false },
        "no-video": { type: "boolean", default: false },
        full: { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 2);
  }
}

export function parseViewport(value: string): { width: number; height: number } | null {
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}
