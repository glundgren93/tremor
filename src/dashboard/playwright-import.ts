import { createRequire } from "node:module";

export async function importPlaywright(): Promise<typeof import("playwright")> {
  try {
    return await import("playwright");
  } catch {}
  try {
    const req = createRequire(`${process.cwd()}/package.json`);
    return req("playwright");
  } catch {}
  try {
    const { execSync } = await import("node:child_process");
    const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    const req = createRequire(`${globalRoot}/package.json`);
    return req("playwright");
  } catch {}
  throw new Error("Playwright not found");
}
