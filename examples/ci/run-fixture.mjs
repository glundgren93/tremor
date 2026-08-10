#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { resolve } from "node:path";
import { promisify } from "node:util";
const exec = promisify(execFile);
const out = resolve(process.argv[2] ?? "tremor-fixture-results");
await mkdir(out, { recursive: true });
const sentinel = "fixture-secret-token-9f8e7d6c";
const server = http.createServer((req, res) => {
  if (req.url === "/api/data") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ apiKey: sentinel, fixture: true }));
  if (req.url === "/dynamic") return void res.writeHead(200, { "content-type": "text/html" }).end('<div id="value">loading</div><script>fetch("/api/data").then(r=>{if(!r.ok)throw Error();return r.json()}).then(()=>value.textContent="loaded").catch(()=>value.textContent="changed")</script>');
  res.writeHead(200, { "content-type": "text/html" }).end("<h1>static fixture</h1>");
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const { port } = server.address();
const origin = `http://127.0.0.1:${port}`;
async function run(name, args, expectedCode = 0) {
  const runOut = `${out}/${name}-runs`;
  let stdout = "", exitCode = 0;
  try { ({ stdout } = await exec("node", ["dist/cli/main.mjs", ...args, "--out", runOut, "--no-video"], { maxBuffer: 20_000_000 })); }
  catch (error) { stdout = error.stdout; exitCode = error.code; }
  if (exitCode !== expectedCode) throw new Error(`${name}: expected exit ${expectedCode}, got ${exitCode}`);
  const envelope = JSON.parse(stdout);
  const stdoutPath = `${out}/${name}-stdout.json`;
  await writeFile(stdoutPath, stdout);
  return { stdout: stdoutPath, result: envelope.full ?? null, exitCode };
}
try {
  const entries = {
    routeChaosDigest: await run("route-chaos-digest", ["chaos", `${origin}/dynamic`, "--routes", "/dynamic", "--budget", "1", "--proof-limit", "1"]),
    routeChaosFull: await run("route-chaos-full", ["chaos", `${origin}/dynamic`, "--routes", "/dynamic", "--budget", "1", "--proof-limit", "1", "--full"]),
    staticChaosDigest: await run("static-chaos-digest", ["chaos", `${origin}/static`, "--budget", "1", "--proof-limit", "0"]),
    staticChaosFull: await run("static-chaos-full", ["chaos", `${origin}/static`, "--budget", "1", "--proof-limit", "0", "--full"]),
    routeScanDigest: await run("route-scan-digest", ["scan", origin, "--routes", "/dynamic,/static"]),
    routeScanFull: await run("route-scan-full", ["scan", origin, "--routes", "/dynamic,/static", "--full"]),
    usageError: await run("usage-error", ["scan"], 2),
  };
  const archived = await Promise.all(Object.values(entries).flatMap((entry) => [entry.stdout, entry.result].filter(Boolean)).map((path) => readFile(path, "utf8")));
  if (!archived.some((text) => text.includes("[REDACTED]"))) throw new Error("sentinel response was not captured and redacted");
  if (archived.some((text) => text.includes(sentinel))) throw new Error("fixture token reached archived output");
  await writeFile(`${out}/manifest.json`, JSON.stringify({ fixtureVersion: 1, outputRoot: out, entries }, null, 2));
} finally { await new Promise((ok) => server.close(ok)); }
