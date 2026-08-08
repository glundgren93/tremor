import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

export type ProfileMetadata = {
  schemaVersion: 1;
  name: string;
  origin: string;
  createdAt: string;
  updatedAt: string;
  browser: string;
  storageState: string;
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export function validateProfileName(name: string): string {
  if (!SAFE_NAME.test(name)) throw new Error("Invalid profile name");
  return name;
}

export function profileHome(): string {
  return (
    process.env.TREMOR_HOME ||
    join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || ".", ".config"), "tremor")
  );
}

function originOf(value: string): string {
  const url = new URL(value);
  if (!/^https?:$/.test(url.protocol)) throw new Error("Profile URL must use http or https");
  return url.origin;
}

async function secureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory())
    throw new Error("Refusing symlink or non-directory profile path");
  await chmod(path, 0o700);
}

async function atomicWrite(path: string, content: string): Promise<void> {
  const temp = `${path}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

async function regular(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Refusing symlink or non-file");
}

function metadataValid(meta: unknown, name: string, dir: string): meta is ProfileMetadata {
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Partial<ProfileMetadata>;
  if (
    m.schemaVersion !== 1 ||
    m.name !== name ||
    typeof m.origin !== "string" ||
    m.storageState !== "storage-state.json"
  )
    return false;
  try {
    if (originOf(m.origin) !== m.origin) return false;
  } catch {
    return false;
  }
  const state = resolve(dir, m.storageState);
  return state === join(dir, m.storageState) && !m.storageState.includes(sep + sep);
}

export async function saveProfile(
  name: string,
  targetUrl: string,
  state: unknown,
  browser = "chromium",
): Promise<ProfileMetadata> {
  validateProfileName(name);
  const origin = originOf(targetUrl);
  const root = join(profileHome(), "profiles");
  const dir = join(root, name);
  await secureDir(root);
  await secureDir(dir);
  let createdAt = new Date().toISOString();
  try {
    createdAt = (await loadProfile(name)).metadata.createdAt;
  } catch {
    /* new profile */
  }
  const metadata: ProfileMetadata = {
    schemaVersion: 1,
    name,
    origin,
    createdAt,
    updatedAt: new Date().toISOString(),
    browser,
    storageState: "storage-state.json",
  };
  const statePath = join(dir, metadata.storageState);
  const metadataPath = join(dir, "metadata.json");
  await atomicWrite(statePath, JSON.stringify(state));
  await atomicWrite(metadataPath, JSON.stringify(metadata, null, 2));
  return metadata;
}

export async function loadProfile(
  name: string,
  targetUrl?: string,
): Promise<{ metadata: ProfileMetadata; storageStatePath: string }> {
  validateProfileName(name);
  const dir = join(profileHome(), "profiles", name);
  const metadataPath = join(dir, "metadata.json");
  await regular(metadataPath);
  let metadata: unknown;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch {
    throw new Error("Corrupt auth profile metadata");
  }
  if (!metadataValid(metadata, name, dir)) throw new Error("Corrupt auth profile metadata");
  if (targetUrl && originOf(targetUrl) !== metadata.origin)
    throw new Error(`Auth profile origin mismatch: expected ${metadata.origin}`);
  const storageStatePath = join(dir, metadata.storageState);
  await regular(storageStatePath);
  return { metadata, storageStatePath };
}

export async function listProfiles(): Promise<ProfileMetadata[]> {
  try {
    const names = await readdir(join(profileHome(), "profiles"));
    return (
      await Promise.all(
        names.map(async (name) => {
          try {
            return (await loadProfile(name)).metadata;
          } catch {
            return null;
          }
        }),
      )
    ).filter((p): p is ProfileMetadata => p !== null);
  } catch {
    return [];
  }
}

export async function removeProfile(name: string): Promise<void> {
  validateProfileName(name);
  const dir = join(profileHome(), "profiles", name);
  const info = await lstat(dir).catch(() => null);
  if (!info) throw new Error("Profile not found");
  if (info.isSymbolicLink()) throw new Error("Refusing symlink profile path");
  await rm(dir, { recursive: true });
}

export function untilUrlMatches(current: string, expected: string): boolean {
  return expected.endsWith("*") ? current.startsWith(expected.slice(0, -1)) : current === expected;
}

export function validateAuthSelection(profile?: string, authState?: string): void {
  if (profile && authState) throw new Error("--profile and --auth-state cannot be used together");
}
