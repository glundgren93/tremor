#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const release = JSON.parse(await readFile(join(root, "release.json"), "utf8"));
const command = process.argv[2];

if (command === "check") {
  await checkRelease(process.argv[3] ?? process.env.RELEASE_TAG);
} else if (command === "smoke") {
  await smoke(parseSmokeArgs(process.argv.slice(3)));
} else {
  throw new Error("Usage: node scripts/release.mjs check [tag] | smoke --tarball <path> [--previous <path>]");
}

async function checkRelease(expectedTag) {
  requireText(release.version, "release.version");
  requireText(release.tag, "release.tag");
  requireText(release.previousVersion, "release.previousVersion");
  requireText(release.previousTag, "release.previousTag");
  if (release.schemaVersion !== 1) throw new Error("unsupported release schema");
  if (pkg.version !== release.version) throw new Error(`package version ${pkg.version} != release ${release.version}`);
  if (release.tag !== `v${release.version}`) throw new Error("release tag must match package version");
  if (release.previousTag !== `v${release.previousVersion}`) throw new Error("previous tag must match previous version");
  if (release.asset !== "tremor.tgz" || release.checksum !== "tremor.tgz.sha256") {
    throw new Error("canonical release asset names changed unexpectedly");
  }
  if (expectedTag && expectedTag !== release.tag) throw new Error(`tag ${expectedTag} != release ${release.tag}`);
  if (!Array.isArray(release.supported?.node) || !release.supported.node.includes("20") || !release.supported.node.includes("22")) {
    throw new Error("supported Node releases must include 20 and 22");
  }
  if (release.supported?.browser !== "Google Chrome stable") throw new Error("release browser must be Google Chrome stable");
  if (release.npmPublication?.status !== "disabled" || !release.npmPublication?.reason) {
    throw new Error("npm publication policy must be explicit");
  }
  if (pkg.scripts?.prepare) throw new Error("install-time prepare is not allowed");
  if (pkg.scripts?.prepack !== "npm run build") throw new Error("prepack must build the package");
  if (!pkg.files?.includes("release.json")) throw new Error("release metadata must be packaged");
  const sourceVersion = await readFile(join(root, "src/version.ts"), "utf8");
  if (!sourceVersion.includes(`VERSION = "${pkg.version}"`)) throw new Error("source version mismatch");
  process.stdout.write(`release configuration valid: ${release.tag}\n`);
}

function parseSmokeArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !["--tarball", "--previous"].includes(flag)) throw new Error(`invalid smoke argument: ${flag ?? "missing"}`);
    parsed[flag.slice(2)] = resolve(value);
  }
  if (!parsed.tarball) throw new Error("--tarball is required");
  return parsed;
}

async function smoke({ tarball, previous }) {
  await checkRelease();
  await stat(tarball);
  if (previous) await stat(previous);
  const work = await mkdtemp(join(tmpdir(), "tremor-release-smoke-"));
  await chmod(work, 0o700);
  const prefix = join(work, "prefix");
  try {
    if (previous) {
      await install(previous, prefix, true);
      await verifyInstalled(prefix, release.previousVersion, false);
    }
    await install(tarball, prefix, false);
    await verifyInstalled(prefix, release.version, true);
    await runPackagedStaticProbe(prefix, work);
    process.stdout.write(`packaged CLI smoke passed: ${release.version}${previous ? ` (upgraded from ${release.previousVersion})` : ""}\n`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

async function install(tarball, prefix, ignoreScripts) {
  const args = ["install", "--global", "--no-audit", "--no-fund", "--prefix", prefix, tarball];
  if (ignoreScripts) args.splice(2, 0, "--ignore-scripts");
  await run("npm", args, {
    cwd: dirname(tarball),
    timeoutMs: 180_000,
  });
}

async function verifyInstalled(prefix, expectedVersion, forbidPrepare) {
  const executable = join(prefix, "bin", "tremor");
  const result = await run(executable, ["--version"], { cwd: prefix, timeoutMs: 10_000 });
  if (result.stdout.trim() !== expectedVersion) throw new Error(`installed CLI version ${result.stdout.trim()} != ${expectedVersion}`);
  const installedPackage = JSON.parse(
    await readFile(join(prefix, "lib", "node_modules", "@glundgren93", "tremor", "package.json"), "utf8"),
  );
  if (installedPackage.version !== expectedVersion) throw new Error("installed package metadata version mismatch");
  if (forbidPrepare && installedPackage.scripts?.prepare) {
    throw new Error("installed package contains an install-time prepare script");
  }
}

async function runPackagedStaticProbe(prefix, work) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>release smoke</title><main>static release smoke</main>");
  });
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("release smoke server did not bind");
    const out = join(work, "runs");
    const executable = join(prefix, "bin", "tremor");
    const result = await run(
      executable,
      ["chaos", `http://127.0.0.1:${address.port}/`, "--budget", "1", "--proof-limit", "1", "--no-video", "--out", out],
      { cwd: work, timeoutMs: 45_000 },
    );
    const envelope = JSON.parse(result.stdout);
    if (envelope.schemaVersion !== 1 || envelope.command !== "chaos") throw new Error("packaged CLI returned an invalid envelope");
    const payload = envelope.result ?? envelope;
    if (payload.applicability?.status !== "not-applicable") throw new Error("packaged static smoke was not factual not-applicable");
    const fullPath = envelope.full;
    if (typeof fullPath !== "string") throw new Error("packaged CLI digest did not reference a full result");
    const absoluteFull = resolve(work, fullPath);
    const rel = relative(out, absoluteFull);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("packaged result escaped the private output root");
    if (((await stat(absoluteFull)).mode & 0o077) !== 0) throw new Error("packaged full result is not private");
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
}

function run(executable, args, { cwd, timeoutMs }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let overflow = false;
    const append = (current, chunk) => {
      const next = current + chunk.toString();
      if (Buffer.byteLength(next) > 2 * 1024 * 1024) {
        overflow = true;
        child.kill("SIGKILL");
        return current;
      }
      return next;
    };
    child.stdout.on("data", (chunk) => (stdout = append(stdout, chunk)));
    child.stderr.on("data", (chunk) => (stderr = append(stderr, chunk)));
    child.once("error", reject);
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (overflow) return reject(new Error(`${executable} exceeded the output limit`));
      if (code !== 0) return reject(new Error(`${executable} failed (${code ?? signal}): ${stderr.slice(-4000)}`));
      resolveRun({ stdout, stderr });
    });
  });
}

function requireText(value, field) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${field} must be a non-empty string`);
}
