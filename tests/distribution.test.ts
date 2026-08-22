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
      upgradeFromTag: `v${release.upgradeFromVersion}`,
      asset: "tremor.tgz",
      checksum: "tremor.tgz.sha256",
      supported: {
        node: ["20", "22"],
        browser: "Google Chrome stable",
        platforms: ["Linux", "macOS"],
      },
      npmPublication: {
        status: "enabled",
        registry: "https://registry.npmjs.org/",
        access: "public",
        authentication: "trusted-publishing",
        publisher: {
          provider: "github-actions",
          repository: "glundgren93/tremor",
          workflow: "release.yml",
        },
      },
    });
    expect(VERSION).toBe(pkg.version);
    expect(pkg.engines.node).toBe(">=20");
    expect(pkg.publishConfig).toEqual({
      access: "public",
      registry: "https://registry.npmjs.org/",
    });
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
    expect(workflow).toContain("git merge-base --is-ancestor HEAD refs/remotes/origin/main");
    expect(workflow).toContain("pnpm test:e2e");
    expect(workflow).toContain("pnpm exec playwright install --with-deps chrome");
    expect(workflow).toContain("pnpm release:smoke");
    expect(workflow).toContain("--previous");
    expect(workflow).toContain("sha256sum -c tremor.tgz.sha256");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("does not support trusted publishing");
    expect(workflow).not.toContain("cache: false");
    expect(workflow).toContain("minor === 5 && patch < 1");
    expect(workflow).toContain("npm publish release-assets/tremor.tgz --access public");
    expect(workflow).toContain("dist.integrity");
    expect(workflow).toContain("local_integrity");
    expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
    for (const action of [
      "actions/checkout@11d5960a326750d5838078e36cf38b85af677262",
      "pnpm/action-setup@f40ffcd9367d9f12939873eb1018b921a783ffaa",
      "actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020",
      "browser-actions/setup-chrome@19ae4b339ee18925ab85cf12c1041150ea4a44c8",
      "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    ]) {
      expect(workflow).toContain(action);
    }
    const artifactDownload = workflow.indexOf(
      "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    );
    const npmPublish = workflow.indexOf("npm publish release-assets/tremor.tgz");
    const createDraft = workflow.indexOf("gh release create");
    const upload = workflow.indexOf("gh release upload");
    const releaseDownload = workflow.lastIndexOf("gh release download");
    const publish = workflow.indexOf('gh release edit "$TAG" --draft=false');
    expect(createDraft).toBeGreaterThan(artifactDownload);
    expect(upload).toBeGreaterThan(createDraft);
    expect(releaseDownload).toBeGreaterThan(upload);
    expect(npmPublish).toBeGreaterThan(releaseDownload);
    expect(publish).toBeGreaterThan(npmPublish);
  });

  it("runs quality once and package smoke on pairwise platform coverage", async () => {
    const workflow = await load(".github/workflows/ci.yml");
    expect(workflow).toContain("quality:");
    expect(workflow).toContain("- os: ubuntu-latest\n            node: 20");
    expect(workflow).toContain("- os: macos-latest\n            node: 22");
    expect(workflow.match(/^\s+pnpm test$/gm)).toHaveLength(1);
    expect(workflow).not.toContain("pnpm schema:check");
    expect(workflow).toContain("npm pack");
    expect(workflow).toContain("pnpm release:smoke --tarball");
    expect(workflow).toContain("browser-actions/setup-chrome@v1");
    expect(workflow).toContain("browser-e2e:");
    expect(workflow).toContain("pnpm test:e2e");
    expect(workflow).toContain("pnpm exec playwright install --with-deps chrome");
  });

  it("runs deterministic benchmarks only for relevant changes", async () => {
    const workflow = await load(".github/workflows/tremor-benchmarks.yml");
    expect(workflow).toContain("push:\n    branches: [main]");
    expect(workflow.match(/- "src\/\*\*"/g)).toHaveLength(2);
    expect(workflow.match(/- "pnpm-lock.yaml"/g)).toHaveLength(2);
    expect(workflow).not.toContain('"README.md"');
    expect(workflow).toContain("workflow_dispatch:");
  });
});
