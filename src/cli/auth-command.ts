import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { listProfiles, removeProfile, saveProfile, untilUrlMatches } from "../auth/profiles";
import { fail } from "./run-dir";

export async function authCommand(argv: string[]): Promise<void> {
  const sub = argv[0];
  if (sub === "list") return authList();
  if (sub === "remove") return authRemove(argv[1]);
  if (sub !== "setup")
    fail("Usage: tremor auth setup <url> --profile <name> [--until-url <url-or-prefix>]", 2);
  await authSetup(argv);
}

async function authList(): Promise<void> {
  process.stdout.write(`${JSON.stringify(await listProfiles())}\n`);
}

async function authRemove(name: string | undefined): Promise<void> {
  if (!name) fail("Usage: tremor auth remove <name>", 2);
  try {
    await removeProfile(name);
    process.stdout.write(`${JSON.stringify({ removed: name })}\n`);
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), 2);
  }
}

async function authSetup(argv: string[]): Promise<void> {
  const p = (() => {
    try {
      return parseArgs({
        args: argv.slice(1),
        allowPositionals: true,
        options: {
          profile: { type: "string" },
          "until-url": { type: "string" },
          "auth-timeout": { type: "string", default: "300000" },
        },
      });
    } catch (e) {
      return fail(String(e), 2);
    }
  })();
  const url = p.positionals[0],
    name = p.values.profile as string | undefined,
    until = p.values["until-url"] as string | undefined;
  if (!url || !name)
    fail("Usage: tremor auth setup <url> --profile <name> [--until-url <url-or-prefix>]", 2);
  const target = authTarget(url);
  validateUntil(until);
  const timeout = Number(p.values["auth-timeout"]);
  if (!Number.isFinite(timeout) || timeout <= 0) fail("--auth-timeout must be positive", 2);
  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(target.href);
    if (until) {
      const deadline = Date.now() + timeout;
      while (!untilUrlMatches(page.url(), until)) {
        if (Date.now() >= deadline) throw new Error("Timed out waiting for --until-url");
        await new Promise((r) => setTimeout(r, 250));
      }
    } else {
      process.stderr.write("Complete authentication in the browser, then press Enter.\\n");
      await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
    }
    const metadata = await saveProfile(name, target.href, await context.storageState());
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
  } finally {
    await context.close().catch(() => undefined);
    await browser.close().catch(() => undefined);
  }
}

function authTarget(url: string | undefined): URL {
  if (!url)
    fail("Usage: tremor auth setup <url> --profile <name> [--until-url <url-or-prefix>]", 2);
  try {
    const target = new URL(url);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error();
    return target;
  } catch {
    fail("Invalid http(s) URL", 2);
  }
}

function validateUntil(until: string | undefined): void {
  if (!until) return;
  try {
    const target = new URL(until.endsWith("*") ? until.slice(0, -1) : until);
    if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error();
  } catch {
    fail("Invalid --until-url", 2);
  }
}
