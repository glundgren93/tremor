import {
  chmodSync,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DEFAULT_REDACTION_CONFIG, redactUrl, redactUrlsInText } from "../capture/redaction.js";

/**
 * Every command writes one run directory and prints one JSON document.
 *
 * Paths are resolved from cwd, never from the module URL: inside a
 * bun-compiled binary `import.meta.url` points at a read-only virtual fs.
 */
export function createRunDir(outRoot: string, command: string, stamp: string): string {
  const root = isAbsolute(outRoot) ? outRoot : resolve(process.cwd(), outRoot);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory())
    throw new Error("Refusing symlink or non-directory run root");
  const dir = join(root, `${stamp}-${command}`);
  mkdirSync(dir, { mode: 0o700 });
  chmodSync(dir, 0o700);
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
function redactOutput(value: unknown, key = "", literals: readonly string[] = []): unknown {
  const normalizedKey = key.replace(/[-_]/g, "");
  if (/(?:apikey|token|secret|authorization)$/i.test(normalizedKey)) return "[REDACTED]";
  if (typeof value === "string") {
    let safe = /(?:^|target)url$/i.test(key)
      ? redactUrl(value, DEFAULT_REDACTION_CONFIG)
      : redactUrlsInText(value);
    for (const literal of literals) if (literal) safe = safe.split(literal).join("[REDACTED]");
    return safe;
  }
  if (Array.isArray(value)) return value.map((item) => redactOutput(item, key, literals));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, redactOutput(v, k, literals)]),
    );
  return value;
}

export function emit<T, D>(
  envelope: Envelope<T>,
  digest: D,
  full: boolean,
  journeyLiterals: readonly string[] = [],
): void {
  const safeEnvelope = redactOutput(envelope, "", journeyLiterals) as Envelope<T>;
  const resultPath = join(envelope.runDir, "result.json");
  try {
    const existing = lstatSync(resultPath);
    if (existing.isSymbolicLink() || !existing.isFile())
      throw new Error("Refusing symlink or non-file result path");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporaryPath = `${resultPath}.tmp-${process.pid}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(safeEnvelope, null, 2));
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, resultPath);
    chmodSync(resultPath, 0o600);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporaryPath, { force: true });
  }
  const payload = full
    ? safeEnvelope
    : {
        ...safeEnvelope,
        result: redactOutput(digest, "", journeyLiterals),
        full: join(envelope.runDir, "result.json"),
      };
  // stdout is the contract; logs go to stderr (see logging/logger.ts).
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

export function fail(
  message: string,
  code = 1,
  details?: unknown,
  journeyLiterals: readonly string[] = [],
): never {
  const safeDetails = details ? redactOutput(details, "", journeyLiterals) : undefined;
  let safeMessage = redactUrlsInText(stripAnsi(message));
  for (const literal of journeyLiterals)
    if (literal) safeMessage = safeMessage.split(literal).join("[REDACTED]");
  process.stdout.write(
    `${JSON.stringify({ schemaVersion: 1, error: safeMessage, ...(safeDetails ? { details: safeDetails } : {}) }, null, 2)}\n`,
  );
  process.exit(code);
}

/** Playwright embeds ANSI colour codes in its call logs; they are noise in a JSON contract. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI escapes is the point
const ANSI = /\u001b\[[0-9;]*m/g;

export function stripAnsi(value: string): string {
  return value.replace(ANSI, "");
}
