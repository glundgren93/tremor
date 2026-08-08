import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

/**
 * Every command writes one run directory and prints one JSON document.
 *
 * Paths are resolved from cwd, never from the module URL: inside a
 * bun-compiled binary `import.meta.url` points at a read-only virtual fs.
 */
export function createRunDir(outRoot: string, command: string, stamp: string): string {
  const root = isAbsolute(outRoot) ? outRoot : resolve(process.cwd(), outRoot);
  const dir = join(root, `${stamp}-${command}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export type Envelope<T> = {
  schemaVersion: 1;
  command: string;
  url: string;
  startedAt: number;
  durationMs: number;
  runDir: string;
  result: T;
};

/**
 * Full payload to disk, digest to stdout.
 *
 * stdout goes straight into a caller's context window, so it carries the digest
 * unless `--full` is set. `result.json` always holds everything.
 */
export function emit<T, D>(envelope: Envelope<T>, digest: D, full: boolean): void {
  writeFileSync(join(envelope.runDir, "result.json"), JSON.stringify(envelope, null, 2));
  const payload = full
    ? envelope
    : { ...envelope, result: digest, full: join(envelope.runDir, "result.json") };
  // stdout is the contract; logs go to stderr (see logging/logger.ts).
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function fail(message: string, code = 1): never {
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, error: stripAnsi(message) }, null, 2)}\n`,
  );
  process.exit(code);
}

/** Playwright embeds ANSI colour codes in its call logs; they are noise in a JSON contract. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}
