import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version";

const exec = promisify(execFile);
const load = async (path: string) => readFile(path, "utf8");

describe("release distribution contract", () => {
  it("coordinates release, package, source, support, and publication policy", async () => {
    const pkg = JSON.parse(await load("package.json"));
    const release = JSON.parse(await load("release.json"));
    expect(release).toMatchObject({
      schemaVersion: 1,
      version: pkg.version,
      tag: `v${pkg.version}`,
      previousTag: `v${release.previousVersion}`,
      asset: "tremor.tgz",
      checksum: "tremor.tgz.sha256",
      supported: {
        node: ["20", "22"],
        browser: "Google Chrome stable",
        platforms: ["Linux", "macOS"],
      },
      npmPublication: { status: "disabled" },
    });
    expect(VERSION).toBe(pkg.version);
    expect(pkg.engines.node).toBe(">=20");
    expect(pkg.scripts.prepare).toBeUndefined();
    expect(pkg.scripts.prepack).toBe("npm run build");
    expect(pkg.files).toContain("release.json");
  });

  it("validates an exact tag and rejects a mismatched tag", async () => {
    await expect(
      exec(process.execPath, ["scripts/release.mjs", "check", `v${VERSION}`]),
    ).resolves.toMatchObject({
      stdout: expect.stringContaining(`v${VERSION}`),
    });
    await expect(
      exec(process.execPath, ["scripts/release.mjs", "check", "v99.0.0"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("tag v99.0.0"),
    });
  });

  it("keeps tag builds validated and releases draft-first", async () => {
    const workflow = await load(".github/workflows/release.yml");
    expect(workflow).toContain('tags: ["v*.*.*"]');
    expect(workflow).not.toContain("pull_request:");
    expect(workflow).toContain("git status --porcelain");
    expect(workflow).toContain("git rev-list -n 1");
    expect(workflow).toContain("pnpm test:e2e");
    expect(workflow).toContain("pnpm exec playwright install --with-deps chrome");
    expect(workflow).toContain("pnpm release:smoke");
    expect(workflow).toContain("--previous");
    expect(workflow).toContain("sha256sum -c tremor.tgz.sha256");
    const createDraft = workflow.indexOf("gh release create");
    const upload = workflow.indexOf("gh release upload");
    const download = workflow.lastIndexOf("gh release download");
    const publish = workflow.indexOf('gh release edit "$TAG" --draft=false');
    expect(createDraft).toBeGreaterThan(0);
    expect(upload).toBeGreaterThan(createDraft);
    expect(download).toBeGreaterThan(upload);
    expect(publish).toBeGreaterThan(download);
  });

  it("tests packaged commands on the supported platform and Node matrix", async () => {
    const workflow = await load(".github/workflows/ci.yml");
    expect(workflow).toContain("os: [ubuntu-latest, macos-latest]");
    expect(workflow).toContain("node: [20, 22]");
    expect(workflow).toContain("npm pack");
    expect(workflow).toContain("pnpm release:smoke --tarball");
    expect(workflow).toContain("browser-actions/setup-chrome@v1");
    expect(workflow).toContain("browser-e2e:");
    expect(workflow).toContain("pnpm test:e2e");
    expect(workflow).toContain("pnpm exec playwright install --with-deps chrome");
  });
});
