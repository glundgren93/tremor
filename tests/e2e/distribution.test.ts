import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const roots: string[] = [];

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe("packaged distribution", () => {
  it("installs and executes only the tarball CLI in a private clean prefix", async () => {
    const root = await mkdtemp(join(tmpdir(), "tremor-distribution-e2e-"));
    roots.push(root);
    await exec("npm", ["pack", "--pack-destination", root], {
      cwd: process.cwd(),
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const packed = (await readdir(root)).filter((entry) => entry.endsWith(".tgz"));
    expect(packed).toHaveLength(1);
    const tarball = join(root, packed[0] ?? "missing.tgz");
    const result = await exec(
      process.execPath,
      ["scripts/release.mjs", "smoke", "--tarball", tarball],
      {
        cwd: process.cwd(),
        timeout: 180_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
    const release = JSON.parse(await readFile("release.json", "utf8"));
    expect(result.stdout).toContain(`packaged CLI smoke passed: ${release.version}`);
  }, 190_000);
});
