import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  listProfiles,
  loadProfile,
  removeProfile,
  saveProfile,
  untilUrlMatches,
  validateAuthSelection,
  validateProfileName,
} from "../src/auth/profiles";

const homes: string[] = [];
function home() {
  const value = homes.at(-1);
  if (!value) throw new Error("test auth home has not been created");
  process.env.TREMOR_HOME = value;
  return value;
}
afterEach(async () => {
  delete process.env.TREMOR_HOME;
  await Promise.all(homes.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

describe("auth profiles", () => {
  it("saves, loads, lists and removes securely", async () => {
    homes.push(await mkdtemp(join(tmpdir(), "tremor-auth-")));
    home();
    await saveProfile("work", "https://example.com/login", { cookies: [{ secret: "x" }] });
    const loaded = await loadProfile("work", "https://example.com/other");
    expect(loaded.metadata.origin).toBe("https://example.com");
    expect((await listProfiles()).map((p) => p.name)).toEqual(["work"]);
    expect((await lstat(join(home(), "profiles", "work"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(home(), "profiles", "work", "metadata.json"))).mode & 0o777).toBe(
      0o600,
    );
    expect(await readFile(join(home(), "profiles", "work", "metadata.json"), "utf8")).not.toContain(
      "secret",
    );
    await removeProfile("work");
    expect(await listProfiles()).toEqual([]);
  });
  it("rejects unsafe names, mismatched origins, corrupt metadata and symlinks", async () => {
    expect(() => validateProfileName("../bad")).toThrow();
    homes.push(await mkdtemp(join(tmpdir(), "tremor-auth-")));
    home();
    await saveProfile("x", "https://a.test", {});
    await expect(loadProfile("x", "https://b.test")).rejects.toThrow(/origin mismatch/);
    const metadataPath = join(home(), "profiles", "x", "metadata.json");
    await writeFile(
      metadataPath,
      JSON.stringify({
        schemaVersion: 1,
        name: "x",
        origin: "https://a.test",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        browser: "chromium",
        storageState: "../victim.json",
      }),
    );
    await expect(loadProfile("x")).rejects.toThrow(/Corrupt/);
    await writeFile(metadataPath, "bad");
    await expect(loadProfile("x")).rejects.toThrow(/Corrupt/);
  });
  it("atomically replaces file symlinks without overwriting their targets", async () => {
    homes.push(await mkdtemp(join(tmpdir(), "tremor-auth-")));
    const root = home();
    await saveProfile("work", "https://example.com", { cookies: [] });
    const victim = join(root, "victim.json");
    const statePath = join(root, "profiles", "work", "storage-state.json");
    await writeFile(victim, "do-not-overwrite");
    await rm(statePath);
    await symlink(victim, statePath);

    await saveProfile("work", "https://example.com", { cookies: [] });

    expect(await readFile(victim, "utf8")).toBe("do-not-overwrite");
    expect((await lstat(statePath)).isSymbolicLink()).toBe(false);
  });

  it("rejects a symlinked profiles directory", async () => {
    homes.push(await mkdtemp(join(tmpdir(), "tremor-auth-")));
    const root = home();
    const victim = join(root, "victim");
    await mkdir(victim);
    await symlink(victim, join(root, "profiles"));
    await expect(saveProfile("work", "https://example.com", {})).rejects.toThrow(/symlink/);
  });

  it("matches exact and prefix targets and detects conflicts", () => {
    expect(untilUrlMatches("https://a.test/login", "https://a.test/login")).toBe(true);
    expect(untilUrlMatches("https://a.test/login/callback", "https://a.test/login*")).toBe(true);
    expect(untilUrlMatches("https://a.test/other", "https://a.test/login*")).toBe(false);
    expect(() => validateAuthSelection("x", "state.json")).toThrow();
  });
});
