import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { saveProfile } from "../../src/auth/profiles";
import { createPlaywrightDriver } from "../../src/driver/playwright";
import { captureContentState } from "../../src/observers/content";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

async function startFixture(
  options: { expireJourneyAfterDiscovery?: boolean; endpointOnlyDuringDiscovery?: boolean } = {},
): Promise<{
  origin: string;
  sameSiteOrigin: string;
  foreignOrigin: string;
  close(): Promise<void>;
  journeyStats(): {
    bootstrap: number;
    early: number;
    selected: number;
    selectedStatuses: number[];
    later: number;
    markers: string[];
  };
  navigationStats(): { crossOrigin: number; sameOrigin: number };
  routeRuntimeStats(): Record<string, { fresh: number; replay: number }>;
}> {
  let sameSiteApiOrigin = "";
  const journeyCounts = {
    bootstrap: 0,
    early: 0,
    selected: 0,
    selectedStatuses: [] as number[],
    later: 0,
  };
  let crossOriginDocuments = 0;
  let sameOriginDocuments = 0;
  const journeyMarkers: string[] = [];
  let protectedJourneyBootstraps = 0;
  let accountDocuments = 0;
  const routeRuntimeCounts: Record<string, { fresh: number; replay: number }> = {};
  const apiServer = http.createServer((request, response) => {
    if (request.url === "/destination") {
      crossOriginDocuments++;
      response.writeHead(200, { "content-type": "text/html" }).end("destination");
      return;
    }
    if (request.url?.startsWith("/api/same-site")) {
      response.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": request.headers.origin ?? "null",
      });
      response.end('{"items":["important content"]}');
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>((resolve, reject) => {
    apiServer.once("error", reject);
    apiServer.listen(0, "127.0.0.1", () => resolve());
  });
  const apiAddress = apiServer.address();
  if (!apiAddress || typeof apiAddress === "string") throw new Error("fixture API did not bind");
  sameSiteApiOrigin = `http://127.0.0.1:${apiAddress.port}`;

  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/login")) {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><html><body><h1>Login</h1></body></html>");
      return;
    }
    if (
      request.url === "/protected" &&
      !request.headers.cookie?.includes("session=fixture-secret")
    ) {
      response.writeHead(302, { location: "/login?code=sentinel-code&state=sentinel-state" });
      response.end();
      return;
    }
    if (request.url === "/same-site") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body><h1>Feed</h1><div id="feed">Loading</div>
        <script>fetch('${sameSiteApiOrigin}/api/same-site')
          .then(async response => { if (!response.ok) throw new Error('failed'); return response.json(); })
          .then(data => document.querySelector('#feed').textContent = data.items[0])
          .catch(() => document.querySelector('#feed').textContent = 'Algo deu errado');</script>
        </body></html>`);
      return;
    }
    if (request.url === "/static") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><html><body><h1>Static page</h1></body></html>");
      return;
    }
    if (["/dashboard", "/reports", "/settings"].includes(request.url ?? "")) {
      if (!request.headers.cookie?.includes("session=fixture-secret")) {
        response.writeHead(302, { location: "/login" }).end();
        return;
      }
      const path = request.url ?? "";
      let runtime = routeRuntimeCounts[path];
      if (!runtime) {
        runtime = { fresh: 0, replay: 0 };
        routeRuntimeCounts[path] = runtime;
      }
      if (request.headers.cookie?.includes("route-runtime=seen")) runtime.replay++;
      else runtime.fresh++;
      const route = request.url?.slice(1);
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><div id="data">Loading</div><script>
        document.cookie='route-runtime=seen; path=/';
        Promise.all([fetch('/api/shared'), fetch('/api/${route}')]).then(async ([a,b]) => {
          if (!a.ok || !b.ok) throw Error(); document.querySelector('#data').textContent = 'Loaded';
        }).catch(() => document.querySelector('#data').textContent = 'Failed');
      </script>`);
      return;
    }
    if (
      request.url === "/api/shared" ||
      request.url === "/api/dashboard" ||
      request.url === "/api/reports" ||
      request.url === "/api/settings"
    ) {
      response
        .writeHead(200, { "content-type": "application/json" })
        .end('{"items":["route-data"]}');
      return;
    }
    if (request.url === "/api/bootstrap") {
      journeyCounts.bootstrap++;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (request.url === "/api/early") {
      journeyCounts.early++;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (request.url === "/api/later") {
      journeyCounts.later++;
      response.writeHead(200, { "content-type": "application/json" }).end("{}");
      return;
    }
    if (request.url?.startsWith("/api/journey")) {
      journeyCounts.selected++;
      journeyMarkers.push(new URL(request.url, "http://fixture").searchParams.get("context") ?? "");
      const status = request.headers["x-tremor-fault"] ? 503 : 200;
      journeyCounts.selectedStatuses.push(status);
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"message":"Results"}');
      return;
    }
    if (request.url?.startsWith("/api/user")) {
      if (!request.headers.cookie?.includes("session=fixture-secret")) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end('{"error":"unauthorized"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"id":1,"name":"Ada","session":"sentinel-response"}');
      return;
    }

    if (request.url === "/redirect-route") {
      response.writeHead(302, { location: `${sameSiteApiOrigin}/destination` }).end();
      return;
    }
    if (request.url === "/fault-redirect-page") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><div id="status">Loading</div><script type="module">
        try {
          const response = await fetch('/api/fault-redirect');
          if (!response.ok) throw Error();
          document.querySelector('#status').textContent = 'Loaded';
        } catch { location.href = '${sameSiteApiOrigin}/destination'; }
      </script>`);
      return;
    }
    if (request.url === "/api/fault-redirect") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    if (request.url === "/cross-origin-navigation") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><a href="${sameSiteApiOrigin}/destination">Leave origin</a>`);
      return;
    }
    if (request.url === "/undeclared-navigation") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<!doctype html><a href="/undeclared-target">Undeclared</a>');
      return;
    }
    if (request.url === "/undeclared-target") {
      sameOriginDocuments++;
      response.writeHead(200, { "content-type": "text/html" }).end("target");
      return;
    }
    if (request.url === "/unsafe") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<!doctype html><button type='button'>Send unsafe</button><script>document.querySelector('button').onclick=()=>fetch('/api/unsafe',{method:'POST',body:'raw-call-sentinel'})</script>",
      );
      return;
    }
    if (request.url === "/ambiguous") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><button>Duplicate</button><button>Duplicate</button>");
      return;
    }
    if (request.url === "/journey" || request.url === "/journey-protected") {
      if (request.url === "/journey-protected") protectedJourneyBootstraps++;
      if (
        request.url === "/journey-protected" &&
        (!request.headers.cookie?.includes("session=fixture-secret") ||
          (options.expireJourneyAfterDiscovery && protectedJourneyBootstraps > 2))
      ) {
        response.writeHead(302, { location: "/login" }).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html><body>
        <button type="button">Early</button><label>Search <input id="search"></label><button type="button">Search</button><button type="button">Later</button><div role="status" aria-label="Results" hidden>Results</div>
        <script>const marker = crypto.randomUUID(); fetch('/api/bootstrap'); const buttons=document.querySelectorAll('button');
        buttons[0].onclick=()=>fetch('/api/early'); buttons[2].onclick=()=>fetch('/api/later'); buttons[1].onclick = async () => {
          const r = await fetch('/api/journey?context=' + marker + '&q=' + encodeURIComponent(document.querySelector('input').value));
          const s=document.querySelector('[role=status]'); s.hidden=false; s.textContent=r.ok?'Results':'Something went wrong';
        };</script></body></html>`);
      return;
    }

    response.writeHead(200, { "content-type": "text/html" });
    accountDocuments++;
    const fetchUser = !options.endpointOnlyDuringDiscovery || accountDocuments <= 3;
    response.end(`<!doctype html>
      <html><body><h1>Account</h1><div id="user">Loading</div>
      <script>
        ${fetchUser ? "fetch('/api/user?access_token=sentinel-query')" : "Promise.reject(new Error('absent'))"}
          .then(async response => { if (!response.ok) throw new Error('failed'); return response.json(); })
          .then(user => document.querySelector('#user').textContent = user.name)
          .catch(() => document.querySelector('#user').textContent = 'Something went wrong');
      </script></body></html>`);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind a TCP port");

  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    sameSiteOrigin: origin,
    foreignOrigin: sameSiteApiOrigin,
    journeyStats: () => ({
      ...journeyCounts,
      selectedStatuses: [...journeyCounts.selectedStatuses],
      markers: [...journeyMarkers],
    }),
    navigationStats: () => ({
      crossOrigin: crossOriginDocuments,
      sameOrigin: sameOriginDocuments,
    }),
    routeRuntimeStats: () => structuredClone(routeRuntimeCounts),
    close: async () => {
      await Promise.all(
        [server, apiServer].map(
          (fixtureServer) =>
            new Promise<void>((resolve, reject) =>
              fixtureServer.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
    },
  };
}

async function startCropFixture(): Promise<{ origin: string; close(): Promise<void> }> {
  const server = http.createServer((request, response) => {
    if (request.url === "/api/result") {
      response.writeHead(200, { "content-type": "application/json" }).end('{"message":"Ready"}');
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><style>
      html,body{margin:0;background:#fff;font:16px sans-serif;height:2000px} section{position:absolute;left:200px;top:1150px;width:400px;height:200px;background:#def;color:#123}
    </style><section data-testid="result-panel">Loading</section><script>
      fetch('/api/result').then(async r => { if(!r.ok) throw Error(); return r.json() })
       .then(x => document.querySelector('section').textContent=x.message)
       .catch(() => document.querySelector('section').textContent='Service unavailable');
      window.scrollTo(0, 1000);
    </script>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("crop fixture did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function startAttributionFixture(mode: "siblings" | "multiple" | "same-length"): Promise<{
  origin: string;
  close(): Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    if (request.url?.startsWith("/api/")) {
      response.writeHead(200, { "content-type": "application/json" }).end('{"message":"Ready"}');
      return;
    }
    const requests =
      mode === "multiple"
        ? ["/api/items/1", "/api/items/2"]
        : mode === "siblings"
          ? ["/api/shared"]
          : ["/api/same-length"];
    const sections =
      mode === "same-length"
        ? '<section data-testid="same-length-panel">Ready</section>'
        : '<section data-testid="left-panel">Ready</section><section data-testid="right-panel">Ready</section>';
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><style>section{display:inline-block;width:240px;height:120px;margin:20px}</style>
      ${sections}<input value="input-private-sentinel"><select><option selected>select-private-sentinel</option></select><div contenteditable>editable-private-sentinel</div>
      <script>Promise.all(${JSON.stringify(requests)}.map(url => fetch(url).then(r => {if(!r.ok) throw Error(); return r.json()})))
      .then(() => document.querySelectorAll('section').forEach(x => x.textContent='Ready'))
      .catch(() => document.querySelectorAll('section').forEach(x => x.textContent='Error'))</script>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("attribution fixture did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

const pngDimensions = (buffer: Buffer) => ({
  width: buffer.readUInt32BE(16),
  height: buffer.readUInt32BE(20),
});

async function startLatencyFixture(mode: "changed" | "unchanged"): Promise<{
  origin: string;
  methods(): string[];
  close(): Promise<void>;
}> {
  const methods: string[] = [];
  const server = http.createServer((request, response) => {
    if (request.url === "/api/latency") {
      methods.push(request.method ?? "");
      response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`<!doctype html><html><body><div id="result">Loading</div><script>
      (async () => {
        const started = performance.now();
        await fetch('/api/latency');
        const elapsed = performance.now() - started;
        document.querySelector('#result').textContent = ${
          mode === "changed"
            ? "elapsed >= 750 ? 'Slow response' : 'Fast response'"
            : "'Settled response'"
        };
      })();
    </script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("latency fixture did not bind");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    methods: () => [...methods],
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

afterEach(async () => {
  delete process.env.TREMOR_HOME;
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("built Tremor CLI", () => {
  it("collects browser content state without exposing form or locator secrets", async () => {
    const root = await mkdtemp(join(tmpdir(), "tremor-content-privacy-"));
    temporaryPaths.push(root);
    const created = await createPlaywrightDriver({
      url: "about:blank",
      headless: true,
      artifactDir: root,
      viewport: { width: 800, height: 600 },
      timeoutMs: 5_000,
      recordVideo: false,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const driver = created.value;
    try {
      const html = `<main data-testid="raw-panel-key"><p>Safe surrounding text</p>
        <input id="raw-input-id" type="password" value="password-sentinel" placeholder="placeholder-sentinel">
        <select><option selected>option-sentinel</option></select>
        <div contenteditable>editable-sentinel</div></main>`;
      await driver.navigate(`data:text/html,${encodeURIComponent(html)}`);
      const key = "probe-key-sentinel";
      const captured = await captureContentState(driver, key);
      const sameKey = await captureContentState(driver, key);
      const otherKey = await captureContentState(driver, "different-key-sentinel");
      expect(captured.ok && sameKey.ok && otherKey.ok).toBe(true);
      if (!captured.ok || !sameKey.ok || !otherKey.ok) return;
      expect(sameKey.value.regionFingerprints).toEqual(captured.value.regionFingerprints);
      expect(otherKey.value.regionFingerprints).not.toEqual(captured.value.regionFingerprints);
      const serialized = JSON.stringify(captured.value);
      for (const secret of [
        "password-sentinel",
        "option-sentinel",
        "editable-sentinel",
        "raw-panel-key",
        "raw-input-id",
        "placeholder-sentinel",
        "defaultValue",
        '"value"',
        key,
      ])
        expect(serialized).not.toContain(secret);
      expect(serialized).toContain("Safe surrounding text");

      await driver.evaluate(() => {
        const paragraph = document.querySelector("p");
        if (paragraph) paragraph.textContent = "Changed surrounding text";
      });
      const changed = await captureContentState(driver, key);
      expect(changed.ok).toBe(true);
      if (changed.ok)
        expect(changed.value.regionFingerprints).not.toEqual(captured.value.regionFingerprints);

      await driver.evaluate(() => {
        const main = document.querySelector("main");
        if (main)
          main.innerHTML = Array.from(
            { length: 3_000 },
            (_, index) => `<li>item-${index}</li>`,
          ).join("");
      });
      const large = await captureContentState(driver, key);
      expect(large.ok).toBe(true);
      if (large.ok) {
        const metrics = large.value.regions?.[0]?.metrics;
        expect(metrics?.itemCount).toBeLessThanOrEqual(1_000);
        expect(metrics?.textLength).toBeLessThanOrEqual(10_000);
      }
    } finally {
      await driver.close();
    }
  }, 30_000);
  it("advertises the built declarative journey and exact latency option", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["dist/cli/main.mjs", "--help"],
      { cwd: process.cwd() },
    );
    expect(`${stdout}${stderr}`).toContain("--journey <file>");
    expect(`${stdout}${stderr}`).toContain(
      "--fault latency      Select deterministic 1000ms latency (default: deterministic 503)",
    );
  });

  it.each([
    {
      args: ["http://127.0.0.1:1", "--fault", "timeout"],
      message: '--fault currently supports only "latency"',
    },
    {
      args: ["scan", "http://127.0.0.1:1", "--fault", "latency"],
      message: '--fault only applies to "chaos", not "scan"',
    },
    {
      args: ["http://127.0.0.1:1", "--fault", "latency", "--preset", "slow-network"],
      message: "--fault cannot be combined with --preset",
    },
    {
      args: ["http://127.0.0.1:1", "--fault", "latency", "--category", "timing"],
      message: "--fault cannot be combined with --category",
    },
  ])("rejects invalid built latency CLI options before browser launch", async ({
    args,
    message,
  }) => {
    try {
      await execFileAsync(process.execPath, ["dist/cli/main.mjs", ...args], {
        cwd: process.cwd(),
        timeout: 5000,
      });
      throw new Error("expected CLI validation failure");
    } catch (error) {
      const failure = error as { code?: number; stdout?: string };
      expect(failure.code).toBe(2);
      expect(JSON.parse(failure.stdout ?? "{}")).toMatchObject({ error: message });
    }
  });

  it("emits auth metadata JSON with a real trailing newline", async () => {
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-auth-"));
    temporaryPaths.push(root);
    const { stdout } = await execFileAsync(
      process.execPath,
      ["dist/cli/main.mjs", "auth", "list"],
      {
        cwd: process.cwd(),
        env: { ...process.env, TREMOR_HOME: root },
      },
    );
    expect(stdout).toBe("[]\n");
    expect(stdout).not.toContain("\\n");
  });

  it("reports an expired profile without leaking redirect details", async () => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-expired-auth-"));
    temporaryPaths.push(root);
    process.env.TREMOR_HOME = join(root, "config");
    await saveProfile("expired", fixture.origin, { cookies: [] });
    const journeyPath = join(root, "expired-journey.json");
    await writeFile(
      journeyPath,
      JSON.stringify({ version: 1, id: "expired", steps: [{ id: "done", type: "checkpoint" }] }),
    );
    try {
      await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          `${fixture.origin}/protected`,
          "--profile",
          "expired",
          "--journey",
          journeyPath,
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), env: { ...process.env, TREMOR_HOME: process.env.TREMOR_HOME } },
      );
      throw new Error("expected expired auth to fail");
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      expect(failure.code).toBe(1);
      const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      const parsed = JSON.parse(failure.stdout ?? "{}");
      expect(parsed).toMatchObject({ schemaVersion: 1, details: { kind: "authentication" } });
      expect(parsed.error).toContain('profile "expired"');
      expect(parsed.error).toContain(`tremor auth setup ${fixture.origin}/ --profile expired`);
      expect(output).not.toContain("sentinel-code");
      expect(output).not.toContain("sentinel-state");
      expect(output).not.toContain("storage-state.json");
      const files = existsSync(join(root, "runs"))
        ? await readdir(join(root, "runs"), { recursive: true })
        : [];
      expect(files.filter((file) => /\.(?:png|webm)$/i.test(file))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("rejects non-http target URLs before launching a browser", async () => {
    await expect(
      execFileAsync(process.execPath, ["dist/cli/main.mjs", "file:///tmp/secret"], {
        cwd: process.cwd(),
      }),
    ).rejects.toMatchObject({ code: 2 });
  });

  it("attests a browser-approved same-site API fault", async () => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-same-site-"));
    temporaryPaths.push(root);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          `${fixture.sameSiteOrigin}/same-site`,
          "--budget",
          "1",
          "--proof-limit",
          "0",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 },
      );
      const result = JSON.parse(stdout) as {
        result: {
          applicability: { status: string };
          changed: {
            endpoint: string;
            matchedCount: number;
            appliedCount: number;
            appeared: { kind: string }[];
          }[];
          notApplied: unknown[];
          failed: unknown[];
        };
      };
      expect(result.result.applicability.status).toBe("applicable");
      expect(result.result.notApplied).toEqual([]);
      expect(result.result.failed).toEqual([]);
      expect(result.result.changed).toHaveLength(1);
      expect(result.result.changed[0]).toMatchObject({ matchedCount: 1, appliedCount: 1 });
      expect(result.result.changed[0]?.endpoint).toContain("/api/same-site");
      expect(result.result.changed[0]?.appeared.map((item) => item.kind)).toContain(
        "content.error-text-appeared",
      );
    } finally {
      await fixture.close();
    }
  });

  it("discovers a semantic journey in two independent browser contexts", async () => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-journey-"));
    temporaryPaths.push(root);
    const journeyPath = join(root, "journey.json");
    await writeFile(
      journeyPath,
      JSON.stringify({
        version: 1,
        id: "search",
        steps: [
          { id: "early", type: "click", role: "button", name: "Early" },
          { id: "fill", type: "fill", label: "Search", value: "sentinel-fill" },
          { id: "click", type: "click", role: "button", name: "Search" },
          { id: "visible", type: "wait-visible", role: "status", name: "Results" },
          { id: "results", type: "checkpoint" },
          { id: "later-click", type: "click", role: "button", name: "Later" },
          { id: "later", type: "checkpoint" },
        ],
      }),
    );
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          "scan",
          `${fixture.origin}/journey`,
          "--journey",
          journeyPath,
          "--out",
          join(root, "runs"),
          "--full",
          "--filter",
          "/api/journey",
        ],
        { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 },
      );
      const output = JSON.parse(stdout);
      const endpoint = output.result.endpoints.find((e: { pattern: string }) =>
        e.pattern.includes("/api/journey"),
      );
      expect(endpoint).toMatchObject({
        journeyId: "search",
        checkpointId: "results",
        observedStepId: "click",
        replayed: true,
      });
      expect(output.result.endpoints).toHaveLength(1);
      expect(output.result.endpoints[0].pattern).not.toContain("bootstrap");
      const stats = fixture.journeyStats();
      // Exactly two complete discovery runs: first capture plus replay.
      expect(stats).toMatchObject({ bootstrap: 2, early: 2, selected: 2, later: 2 });
      expect(new Set(stats.markers).size).toBe(2);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("preserves a journey authentication failure when auth expires before smoke probing", async () => {
    const fixture = await startFixture({ expireJourneyAfterDiscovery: true });
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-expiring-journey-"));
    temporaryPaths.push(root);
    const config = join(root, "config");
    const runs = join(root, "runs");
    const journeyPath = join(root, "expiring-journey.json");
    process.env.TREMOR_HOME = config;
    await saveProfile("valid-expiring", fixture.origin, {
      cookies: [
        {
          name: "session",
          value: "fixture-secret",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    });
    await writeFile(
      journeyPath,
      JSON.stringify({
        version: 1,
        id: "expiring",
        steps: [
          { id: "fill", type: "fill", label: "Search", value: "fill-leak-sentinel" },
          { id: "click", type: "click", role: "button", name: "Search" },
          { id: "results", type: "checkpoint" },
        ],
      }),
    );
    try {
      await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          `${fixture.origin}/journey-protected`,
          "--profile",
          "valid-expiring",
          "--journey",
          journeyPath,
          "--budget",
          "1",
          "--out",
          runs,
        ],
        { cwd: process.cwd(), env: { ...process.env, TREMOR_HOME: config } },
      );
      throw new Error("expected journey auth expiry to fail");
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      expect(failure.code).toBe(1);
      const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      const parsed = JSON.parse(failure.stdout ?? "{}");
      const remediation = `Authentication profile "valid-expiring" appears expired or invalid. Refresh it with: tremor auth setup ${fixture.origin}/ --profile valid-expiring then retry.`;
      expect(parsed.error).toBe(remediation);
      expect(parsed.details).toMatchObject({
        kind: "authentication",
        journeyId: "expiring",
        action: "authentication",
        receipts: [],
      });
      expect(fixture.journeyStats().selected).toBe(2);
      const files = existsSync(runs) ? await readdir(runs, { recursive: true }) : [];
      expect(files.filter((file) => /\.(?:png|webm)$/i.test(file))).toEqual([]);
      for (const secret of [
        "fixture-secret",
        "fill-leak-sentinel",
        "sentinel-code",
        "sentinel-state",
        "storage-state",
      ])
        expect(output).not.toContain(secret);
    } finally {
      await fixture.close();
    }
  }, 45_000);

  it("runs an authenticated journey without leaking profile secrets", async () => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-auth-journey-"));
    temporaryPaths.push(root);
    const config = join(root, "config");
    process.env.TREMOR_HOME = config;
    const journeyPath = join(root, "private-journey.json");
    await saveProfile("valid", fixture.origin, {
      cookies: [
        {
          name: "session",
          value: "fixture-secret",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    });
    await writeFile(
      journeyPath,
      JSON.stringify({
        version: 1,
        id: "private",
        steps: [
          { id: "fill", type: "fill", label: "Search", value: "private-fill-sentinel" },
          { id: "click", type: "click", role: "button", name: "Search" },
          { id: "visible", type: "wait-visible", role: "status", name: "Results" },
          { id: "results", type: "checkpoint" },
        ],
      }),
    );
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          `${fixture.origin}/journey-protected`,
          "--profile",
          "valid",
          "--journey",
          journeyPath,
          "--budget",
          "1",
          "--proof-limit",
          "0",
          "--filter",
          "/api/journey",
          "--out",
          join(root, "runs"),
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, TREMOR_HOME: config },
          maxBuffer: 2 * 1024 * 1024,
        },
      );
      const envelope = JSON.parse(stdout);
      const fullText = await readFile(envelope.full, "utf8");
      const full = JSON.parse(fullText);
      expect(full.result.outcomes[0]).toMatchObject({ matchedCount: 1, appliedCount: 1 });
      expect(
        full.result.outcomes[0].receipts.find((r: { status: string }) => r.status === "applied"),
      ).toMatchObject({ httpStatus: 503, journeyId: "private" });
      const combined = `${stdout}${stderr}${fullText}`;
      for (const secret of [
        "fixture-secret",
        "private-fill-sentinel",
        "storage-state",
        journeyPath,
      ])
        expect(combined).not.toContain(secret);
    } finally {
      await fixture.close();
    }
  }, 45_000);

  it("runs journey chaos at the selected checkpoint with canonical proof and redacted results", async () => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-journey-chaos-"));
    temporaryPaths.push(root);
    const journeyPath = join(root, "journey.json");
    await writeFile(
      journeyPath,
      JSON.stringify({
        version: 1,
        id: "search-chaos",
        steps: [
          { id: "early", type: "click", role: "button", name: "Early" },
          { id: "fill", type: "fill", label: "Search", value: "sentinel-fill" },
          { id: "click", type: "click", role: "button", name: "Search" },
          { id: "visible", type: "wait-visible", role: "status", name: "Results" },
          { id: "results", type: "checkpoint" },
          { id: "later-click", type: "click", role: "button", name: "Later" },
          { id: "later", type: "checkpoint" },
        ],
      }),
    );
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          `${fixture.origin}/journey`,
          "--journey",
          journeyPath,
          "--budget",
          "1",
          "--proof-limit",
          "1",
          "--filter",
          "/api/journey",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 },
      );
      const envelope = JSON.parse(stdout) as { full: string };
      const fullText = await readFile(envelope.full, "utf8");
      const full = JSON.parse(fullText);
      const outcome = full.result.outcomes[0];
      expect(outcome.scenario).toMatchObject({ category: "error" });
      expect(outcome.scenario.endpoint).toContain("/api/journey");
      expect(
        outcome.receipts.filter((r: { status: string }) => r.status === "matched"),
      ).toHaveLength(1);
      expect(
        outcome.receipts.filter((r: { status: string }) => r.status === "applied"),
      ).toHaveLength(1);
      expect(
        outcome.receipts.find((r: { status: string }) => r.status === "applied"),
      ).toMatchObject({
        httpStatus: 503,
        journeyId: "search-chaos",
        checkpointId: "results",
        observedStepId: "click",
      });
      expect(outcome.appeared.length + outcome.disappeared.length).toBeGreaterThan(0);
      expect(full.result.journey).toMatchObject({ id: "search-chaos" });
      expect(full.result.journey.receipts.map((r: { stepId: string }) => r.stepId)).toEqual([
        "early",
        "fill",
        "click",
        "visible",
        "results",
        "later-click",
        "later",
      ]);
      const shots = [outcome.proof.baselineShot, outcome.proof.faultedShot];
      expect(shots.map((p: string) => p.split("/").at(-1))).toEqual([
        "001-baseline.png",
        "001-faulted-final.png",
      ]);
      expect(shots.every((p: string) => existsSync(p))).toBe(true);
      expect(fullText).not.toContain("sentinel-fill");
      expect(stdout).not.toContain("sentinel-fill");
      expect(
        outcome.receipts.every((r: { journeyId?: string }) => r.journeyId === "search-chaos"),
      ).toBe(true);
      expect(
        outcome.receipts.some(
          (r: { status: string }) => r.status === "unknown" || r.status === "guard",
        ),
      ).toBe(false);
      const stats = fixture.journeyStats();
      // Two discovery runs execute later. Smoke and proof each add clean baseline + fault runs
      // stopped at results; both faulted selected calls are fulfilled in-browser. Thus early is
      // clean 2+2+2 times, while the server sees 2 discovery + 2 baseline selected calls.
      expect(stats).toMatchObject({ bootstrap: 6, early: 6, selected: 4, later: 2 });
      expect(stats.selectedStatuses).toEqual([200, 200, 200, 200]);
    } finally {
      await fixture.close();
    }
  }, 45_000);

  it.each([
    { route: "cross-origin-navigation", name: "Leave origin", counter: "crossOrigin" },
    { route: "undeclared-navigation", name: "Undeclared", counter: "sameOrigin" },
  ])("blocks $route before dispatching its document request", async ({ route, name, counter }) => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), `tremor-e2e-${route}-`));
    temporaryPaths.push(root);
    const journeyPath = join(root, "journey.json");
    await writeFile(
      journeyPath,
      JSON.stringify({
        version: 1,
        id: route,
        steps: [
          { id: "click", type: "click", role: "link", name },
          { id: "done", type: "checkpoint" },
        ],
      }),
    );
    try {
      await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          `${fixture.origin}/${route}`,
          "--journey",
          journeyPath,
          "--proof-limit",
          "1",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 },
      );
      throw new Error("expected navigation failure");
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      expect(failure.code).toBe(1);
      expect(JSON.parse(failure.stdout ?? "{}")).toMatchObject({
        details: { kind: "navigation-blocked" },
      });
      expect(fixture.navigationStats()[counter as "crossOrigin" | "sameOrigin"]).toBe(0);
      const files = existsSync(join(root, "runs"))
        ? await readdir(join(root, "runs"), { recursive: true })
        : [];
      expect(files.filter((file) => /\.(?:png|webm)$/i.test(file))).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it.each([
    {
      route: "unsafe",
      kind: "unsafe-request-blocked",
      steps: [
        { id: "send", type: "click", role: "button", name: "Send unsafe" },
        { id: "done", type: "checkpoint" },
      ],
    },
    {
      route: "ambiguous",
      kind: "ambiguous-target",
      steps: [
        { id: "click", type: "click", role: "button", name: "Duplicate" },
        { id: "done", type: "checkpoint" },
      ],
    },
  ])("fails $route journeys safely without proof or private diagnostics", async ({
    route,
    kind,
    steps,
  }) => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), `tremor-e2e-${route}-`));
    temporaryPaths.push(root);
    const journeyPath = join(root, "journey.json");
    await writeFile(journeyPath, JSON.stringify({ version: 1, id: route, steps }));
    try {
      await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          `${fixture.origin}/${route}`,
          "--journey",
          journeyPath,
          "--budget",
          "1",
          "--proof-limit",
          "1",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 },
      );
      throw new Error("expected journey failure");
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string };
      expect(failure.code).toBe(1);
      const output = `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
      expect(output).toContain(kind);
      for (const secret of [
        "Duplicate",
        "raw-call-sentinel",
        "getByRole",
        "storage-state",
        journeyPath,
      ])
        expect(output).not.toContain(secret);
      const files = existsSync(join(root, "runs"))
        ? await readdir(join(root, "runs"), { recursive: true })
        : [];
      expect(files.filter((file) => /\.(?:png|webm)$/i.test(file))).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("keeps a never-matched smoke scenario at zero proof images", async () => {
    const fixture = await startFixture({ endpointOnlyDuringDiscovery: true });
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-never-matched-"));
    temporaryPaths.push(root);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          fixture.origin,
          "--budget",
          "1",
          "--proof-limit",
          "1",
          "--no-video",
          "--filter",
          "/api/user",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const digest = JSON.parse(stdout);
      expect(digest.result.changed).toEqual([]);
      expect(digest.result.notApplied).toHaveLength(1);
      expect(digest.result.notApplied[0]).toMatchObject({ reason: "never-matched" });
      const persisted = JSON.parse(await readFile(digest.full, "utf8"));
      expect(persisted.result.budget).toMatchObject({ smoke: 1, proof: 0 });
      expect(persisted.result.outcomes[0]).toMatchObject({ matchedCount: 0, appliedCount: 0 });
      const files = await readdir(join(root, "runs"), { recursive: true });
      expect(files.filter((file) => /\.(?:png|webm)$/i.test(file))).toEqual([]);
    } finally {
      await fixture.close();
    }
  }, 25_000);

  it("emits deterministic cropped semantic proof from the built CLI", async () => {
    const fixture = await startCropFixture();
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-crop-"));
    temporaryPaths.push(root);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          fixture.origin,
          "--budget",
          "1",
          "--proof-limit",
          "1",
          "--no-video",
          "--filter",
          "/api/result",
          "--viewport",
          "1280x720",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 },
      );
      const digest = JSON.parse(stdout) as { full: string; result: { changed: unknown[] } };
      expect(digest.result.changed).toHaveLength(1);
      const fullText = await readFile(digest.full, "utf8");
      expect(fullText).not.toContain("result-panel");
      const full = JSON.parse(fullText);
      const outcome = full.result.outcomes[0];
      expect(outcome).toMatchObject({ matchedCount: 1, appliedCount: 1 });
      expect(outcome.attributions).toHaveLength(1);
      const attribution = outcome.attributions[0];
      expect(attribution).toMatchObject({
        version: 1,
        status: "attributed",
        evidence: { appliedReceiptCount: 1, changedTrustedRegionCount: 1 },
      });
      const referenced = outcome.receipts[attribution.receipt.receiptIndex];
      const { receiptIndex: _receiptIndex, ...receiptFields } = attribution.receipt;
      expect(referenced).toMatchObject(receiptFields);
      expect(attribution.regionDeltas).toHaveLength(1);
      expect(attribution.regionDeltas[0]).toMatchObject({
        kind: "section",
        before: { textLength: 5, rowCount: 0, errorPhraseCount: 0 },
        after: { textLength: 19, rowCount: 0, errorPhraseCount: 1 },
      });
      expect(attribution.regionDeltas[0].regionId).toMatch(/^[0-9a-f]{12}$/);
      expect(attribution.regionDeltas[0].changedFields).toEqual([
        "textLength",
        "errorPhraseCount",
        "textContent",
      ]);
      const capture = outcome.proof.captures.faulted;
      expect(capture).toMatchObject({
        framing: "region",
        region: { x: 176, y: 126, width: 448, height: 248 },
        coordinateSpace: "viewport-css-px",
        sourceKinds: ["section"],
      });
      expect(capture.regionId).toMatch(/^[0-9a-f]{12}$/);
      const pngs = (await readdir(join(root, "runs"), { recursive: true })).filter((x) =>
        x.endsWith(".png"),
      );
      expect(pngs).toHaveLength(2);
      expect(outcome.proof.faultedShot).toMatch(/faulted-final\.png$/);
      const baseline = await readFile(outcome.proof.baselineShot);
      const faulted = await readFile(outcome.proof.faultedShot);
      expect(pngDimensions(baseline)).toEqual({ width: 1280, height: 720 });
      expect(pngDimensions(faulted)).toEqual({ width: 448, height: 248 });
      expect(capture.byteSize).toBe(faulted.byteLength);
      expect(outcome.proof.captures.baseline.byteSize).toBe(baseline.byteLength);
      expect(baseline.byteLength).toBeGreaterThan(0);
      expect(faulted.byteLength).toBeGreaterThan(0);
      expect(baseline.byteLength).toBeLessThan(1_500_000);
      expect(faulted.byteLength).toBeLessThan(500_000);
      expect(baseline.byteLength + faulted.byteLength).toBeLessThan(2_000_000);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("attributes one shared request to two stable sibling regions with viewport proof", async () => {
    const fixture = await startAttributionFixture("siblings");
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-attribution-siblings-"));
    temporaryPaths.push(root);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          fixture.origin,
          "--budget",
          "1",
          "--proof-limit",
          "1",
          "--no-video",
          "--filter",
          "/api/shared",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), timeout: 25_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const digest = JSON.parse(stdout);
      const fullText = await readFile(digest.full, "utf8");
      for (const sentinel of [
        "left-panel",
        "right-panel",
        "input-private-sentinel",
        "select-private-sentinel",
        "editable-private-sentinel",
      ])
        expect(fullText).not.toContain(sentinel);
      const outcome = JSON.parse(fullText).result.outcomes[0];
      expect(outcome.appliedCount).toBe(1);
      expect(outcome.attributions).toHaveLength(1);
      expect(outcome.attributions[0].status).toBe("attributed");
      const deltas = outcome.attributions[0].regionDeltas;
      expect(deltas).toHaveLength(2);
      expect(deltas.map((delta: { regionId: string }) => delta.regionId)).toEqual(
        [...deltas.map((delta: { regionId: string }) => delta.regionId)].sort(),
      );
      expect(outcome.proof.captures.faulted).toMatchObject({
        framing: "viewport",
        fallbackReason: "multiple-regions",
      });
      const pngs = (await readdir(join(root, "runs"), { recursive: true })).filter((file) =>
        file.endsWith(".png"),
      );
      expect(pngs).toHaveLength(2);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("keeps two normalized applied requests ambiguous without guessed regions", async () => {
    const fixture = await startAttributionFixture("multiple");
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-attribution-multiple-"));
    temporaryPaths.push(root);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          fixture.origin,
          "--budget",
          "1",
          "--proof-limit",
          "0",
          "--no-video",
          "--filter",
          "/api/items",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const digest = JSON.parse(stdout);
      const fullText = await readFile(digest.full, "utf8");
      expect(fullText).not.toMatch(
        /left-panel|right-panel|input-private-sentinel|select-private-sentinel|editable-private-sentinel/,
      );
      const result = JSON.parse(fullText).result;
      expect(result.outcomes).toHaveLength(1);
      const outcome = result.outcomes[0];
      const applied = outcome.receipts.filter(
        (receipt: { status: string }) => receipt.status === "applied",
      );
      expect(applied).toHaveLength(2);
      expect(outcome.attributions).toHaveLength(2);
      for (const attribution of outcome.attributions) {
        expect(attribution).toMatchObject({ status: "ambiguous", regionDeltas: [] });
        const { receiptIndex, ...fields } = attribution.receipt;
        expect(outcome.receipts[receiptIndex]).toMatchObject(fields);
      }
    } finally {
      await fixture.close();
    }
  }, 25_000);

  it("detects same-length browser text changes with an opaque textContent fact", async () => {
    const fixture = await startAttributionFixture("same-length");
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-attribution-same-length-"));
    temporaryPaths.push(root);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          fixture.origin,
          "--budget",
          "1",
          "--proof-limit",
          "0",
          "--no-video",
          "--filter",
          "/api/same-length",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
      );
      const digest = JSON.parse(stdout);
      const fullText = await readFile(digest.full, "utf8");
      expect(fullText).not.toContain("same-length-panel");
      const attribution = JSON.parse(fullText).result.outcomes[0].attributions[0];
      expect(attribution).toMatchObject({
        status: "attributed",
        regionDeltas: [{ changedFields: ["errorPhraseCount", "textContent"] }],
      });
      expect(attribution.regionDeltas[0].before.textLength).toBe(5);
      expect(attribution.regionDeltas[0].after.textLength).toBe(5);
    } finally {
      await fixture.close();
    }
  }, 25_000);

  it("attests a real built-CLI 1000ms latency fault as changed", async () => {
    const fixture = await startLatencyFixture("changed");
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-latency-changed-"));
    temporaryPaths.push(root);
    try {
      const started = Date.now();
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          fixture.origin,
          "--fault",
          "latency",
          "--budget",
          "1",
          "--proof-limit",
          "1",
          "--no-video",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 },
      );
      const wallMs = Date.now() - started;
      expect(wallMs).toBeGreaterThanOrEqual(1000);
      expect(wallMs).toBeLessThan(20_000);
      const digest = JSON.parse(stdout) as {
        result: {
          changed: Array<{ matchedCount: number; appliedCount: number }>;
          notApplied: unknown[];
          failed: unknown[];
        };
        full: string;
      };
      expect(digest.result.changed).toHaveLength(1);
      expect(digest.result.changed[0]).toMatchObject({ matchedCount: 1, appliedCount: 1 });
      expect(digest.result.notApplied).toEqual([]);
      expect(digest.result.failed).toEqual([]);

      const persisted = JSON.parse(await readFile(digest.full, "utf8")) as {
        result: {
          outcomes: Array<{
            scenario: { id: string; name: string; category: string; endpoint: string };
            receipts: Array<Record<string, unknown>>;
            matchedCount: number;
            appliedCount: number;
          }>;
        };
      };
      const outcome = persisted.result.outcomes[0];
      expect(outcome.scenario).toMatchObject({
        name: "GET /api/latency → Latency (1s)",
        category: "timing",
        endpoint: `GET ${fixture.origin}/api/latency`,
      });
      expect(outcome).toMatchObject({ matchedCount: 1, appliedCount: 1 });
      expect(outcome.receipts.map((receipt) => receipt.status)).toEqual(["matched", "applied"]);
      for (const receipt of outcome.receipts) {
        expect(receipt).toMatchObject({
          action: "delay",
          faultType: "latency",
          delayMs: 1000,
          scenarioId: outcome.scenario.id,
          faultId: outcome.scenario.id,
        });
        expect(receipt).not.toHaveProperty("httpStatus");
        expect(["error", "unknown"]).not.toContain(receipt.status);
      }
      expect(fixture.methods().length).toBeGreaterThan(0);
      expect(new Set(fixture.methods())).toEqual(new Set(["GET"]));
      const files = await readdir(join(root, "runs"), { recursive: true });
      const pngs = files.filter((file) => file.endsWith(".png"));
      expect(pngs).toHaveLength(2);
      expect(pngs.some((file) => file.includes("baseline"))).toBe(true);
      expect(pngs.some((file) => file.includes("faulted-final"))).toBe(true);
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("classifies applied latency with settled identical content as unchanged without proof", async () => {
    const fixture = await startLatencyFixture("unchanged");
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-latency-unchanged-"));
    temporaryPaths.push(root);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          fixture.origin,
          "--fault",
          "latency",
          "--budget",
          "1",
          "--proof-limit",
          "1",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 },
      );
      const digest = JSON.parse(stdout) as {
        result: {
          budget: { proof: number };
          changed: unknown[];
          unchanged: string[];
          notApplied: unknown[];
          failed: unknown[];
        };
      };
      expect(digest.result.budget.proof).toBe(0);
      expect(digest.result.changed).toEqual([]);
      expect(digest.result.unchanged).toHaveLength(1);
      expect(digest.result.notApplied).toEqual([]);
      expect(digest.result.failed).toEqual([]);
      const files = await readdir(join(root, "runs"), { recursive: true });
      expect(files.filter((file) => file.endsWith(".png"))).toEqual([]);
      expect(new Set(fixture.methods())).toEqual(new Set(["GET"]));
    } finally {
      await fixture.close();
    }
  }, 30_000);

  it("reports static pages as not applicable without failing the command", async () => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-static-"));
    temporaryPaths.push(root);
    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          `${fixture.origin}/static`,
          "--budget",
          "1",
          "--proof-limit",
          "0",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024 },
      );
      const result = JSON.parse(stdout) as {
        result: {
          applicability: { status: string; reason: string; suggestions: string[] };
          probed: number;
          failed: unknown[];
        };
        full: string;
      };
      expect(result.result).toMatchObject({
        applicability: { status: "not-applicable" },
        probed: 0,
        failed: [],
      });
      expect(result.result.applicability.reason).toContain("GET XHR/fetch");
      expect(existsSync(result.full)).toBe(true);
    } finally {
      await fixture.close();
    }
  });

  it("reuses auth, attests a 503, creates proof, and does not leak captured secrets", async () => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), "tremor-e2e-"));
    temporaryPaths.push(root);
    const tremorHome = join(root, "config");
    process.env.TREMOR_HOME = tremorHome;

    await saveProfile("fixture", `${fixture.origin}/app`, {
      cookies: [
        {
          name: "session",
          value: "fixture-secret",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    });

    try {
      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          `${fixture.origin}/app`,
          "--profile",
          "fixture",
          "--budget",
          "1",
          "--proof-limit",
          "1",
          "--out",
          join(root, "runs"),
        ],
        {
          cwd: process.cwd(),
          env: { ...process.env, TREMOR_HOME: tremorHome },
          maxBuffer: 2 * 1024 * 1024,
        },
      );

      const result = JSON.parse(stdout) as {
        result: {
          budget: { smoke: number; proof: number };
          changed: {
            matchedCount: number;
            appliedCount: number;
            proof: { baseline: string; faulted: string; video: string };
            receipts: Array<Record<string, unknown>>;
          }[];
          notApplied: unknown[];
          failed: unknown[];
        };
        full: string;
      };
      expect(result.result.budget).toMatchObject({ smoke: 1, proof: 1 });
      expect(result.result.notApplied).toEqual([]);
      expect(result.result.failed).toEqual([]);
      expect(result.result.changed).toHaveLength(1);
      expect(result.result.changed[0]).toMatchObject({ matchedCount: 1, appliedCount: 1 });
      expect(existsSync(result.result.changed[0]?.proof.baseline ?? "")).toBe(true);
      expect(existsSync(result.result.changed[0]?.proof.faulted ?? "")).toBe(true);
      expect(existsSync(result.result.changed[0]?.proof.video ?? "")).toBe(true);

      const full = await readFile(result.full, "utf8");
      const persistedRun = JSON.parse(full);
      const defaultReceipts = persistedRun.result.outcomes[0].receipts;
      expect(defaultReceipts.map((receipt: { status: string }) => receipt.status)).toEqual([
        "matched",
        "applied",
      ]);
      for (const receipt of defaultReceipts) {
        expect(receipt).toMatchObject({ action: "fulfill", httpStatus: 503 });
        expect(receipt).not.toHaveProperty("faultType");
        expect(receipt).not.toHaveProperty("delayMs");
      }
      const persisted = `${stdout}\n${full}`;
      expect(persisted).not.toContain("fixture-secret");
      expect(persisted).not.toContain("sentinel-query");
      expect(persisted).not.toContain("sentinel-response");
    } finally {
      await fixture.close();
    }
  });

  it("reports a fault-induced foreign redirect without leaking its origin or retaining proof", async () => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), "tremor-fault-redirect-e2e-"));
    temporaryPaths.push(root);
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          `${fixture.origin}/fault-redirect-page`,
          "--budget",
          "1",
          "--proof-limit",
          "1",
          "--no-video",
          "--filter",
          "/api/fault-redirect",
          "--full",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 },
      );
      const document = JSON.parse(stdout);
      const outcome = document.result.outcomes[0];
      expect(outcome.appeared).toEqual([
        expect.objectContaining({ kind: "navigation.origin-changed" }),
      ]);
      expect(outcome.receipts).toContainEqual(
        expect.objectContaining({ status: "applied", url: `${fixture.origin}/api/fault-redirect` }),
      );
      expect(
        outcome.receipts.every(
          (receipt: { url: string }) => !receipt.url.includes(fixture.foreignOrigin),
        ),
      ).toBe(true);
      expect(`${stdout}${stderr}`).not.toContain(fixture.foreignOrigin);
      expect(outcome.proof).toEqual({ baselineShot: null, faultedShot: null, video: null });
      const files = await readdir(join(root, "runs"), { recursive: true });
      expect(files.filter((file) => /(?:\.png|\.webm|tmp|temp)/iu.test(file))).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it("runs authenticated bounded routes with ownership, global budgets, and scoped artifacts", async () => {
    const fixture = await startFixture();
    const root = await mkdtemp(join(tmpdir(), "tremor-routes-e2e-"));
    temporaryPaths.push(root);
    const state = join(root, "state.json");
    await writeFile(
      state,
      JSON.stringify({
        cookies: [
          {
            name: "session",
            value: "fixture-secret",
            domain: "127.0.0.1",
            path: "/",
            expires: -1,
            httpOnly: false,
            secure: false,
            sameSite: "Lax",
          },
        ],
        origins: [],
      }),
    );
    try {
      const scanRun = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          "scan",
          `${fixture.origin}/origin-only`,
          "--routes",
          "/dashboard,/reports,/static",
          "--auth-state",
          state,
          "--full",
          "--out",
          join(root, "scan-runs"),
        ],
        { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 },
      );
      const scanDocument = JSON.parse(scanRun.stdout);
      expect(scanDocument.result.mode).toBe("routes");
      for (const routeIndex of [0, 1]) {
        const apis = scanDocument.result.routes[routeIndex].scan.endpoints.filter(
          (endpoint: { endpointType: string }) => endpoint.endpointType === "api",
        );
        expect(apis).toHaveLength(2);
        expect(apis.every((endpoint: { replayed: boolean }) => endpoint.replayed)).toBe(true);
      }
      expect(scanDocument.result.routes[2].scan.applicability).toBe("not-applicable");
      expect(scanDocument.result.routes[1].aliases).toEqual(
        expect.arrayContaining([expect.objectContaining({ ownerRouteId: "r01" })]),
      );
      const redirectRoot = join(root, "redirect-runs");
      const redirectError = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          "scan",
          `${fixture.origin}/origin-only`,
          "--routes",
          "/redirect-route",
          "--auth-state",
          state,
          "--out",
          redirectRoot,
        ],
        { cwd: process.cwd() },
      ).catch((error: { code: number; stdout: string; stderr: string }) => error);
      expect(redirectError.code).toBe(1);
      const redirectOutput = `${redirectError.stdout}${redirectError.stderr}`;
      expect(redirectOutput).toContain("Navigation left the expected origin.");
      expect(redirectOutput).not.toContain(fixture.foreignOrigin);
      const redirectFiles = existsSync(redirectRoot)
        ? await readdir(redirectRoot, { recursive: true })
        : [];
      expect(redirectFiles.some((file) => file.endsWith("result.json"))).toBe(false);
      expect(redirectFiles.filter((file) => /(?:\.png|\.webm|tmp|temp)/iu.test(file))).toEqual([]);

      const { stdout } = await execFileAsync(
        process.execPath,
        [
          "dist/cli/main.mjs",
          `${fixture.origin}/origin-only`,
          "--routes",
          "/dashboard,/reports,/static",
          "--auth-state",
          state,
          "--budget",
          "3",
          "--proof-limit",
          "3",
          "--full",
          "--out",
          join(root, "runs"),
        ],
        { cwd: process.cwd(), maxBuffer: 4 * 1024 * 1024 },
      );
      const document = JSON.parse(stdout);
      const result = document.result;
      expect(result.mode).toBe("routes");
      expect(
        result.routes.map((entry: { route: { id: string; path: string } }) => entry.route),
      ).toEqual([
        { id: "r01", path: "/dashboard", url: `${fixture.origin}/dashboard` },
        { id: "r02", path: "/reports", url: `${fixture.origin}/reports` },
        { id: "r03", path: "/static", url: `${fixture.origin}/static` },
      ]);
      expect(result.budget).toMatchObject({ requested: 3, smoke: 3, proof: 3, proofLimit: 3 });
      expect(
        result.routes.flatMap(
          (entry: { outcomes: Array<{ proof: { faultedShot: string | null } }> }) =>
            entry.outcomes.filter((outcome) => outcome.proof.faultedShot).map(() => entry.route.id),
        ),
      ).toEqual(["r01", "r01", "r02"]);
      expect(result.routes[2]).toMatchObject({
        applicability: { status: "not-applicable" },
        budget: { eligible: 0, owned: 0, smoke: 0 },
      });
      expect(
        result.routes.flatMap((entry: { outcomes: unknown[] }) => entry.outcomes),
      ).toHaveLength(3);
      expect(result.routes[1].aliases).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ownerRouteId: "r01", reason: "deduplicated-to-owner" }),
        ]),
      );
      expect(
        result.routes[1].outcomes.some((outcome: { scenario: { id: string } }) =>
          result.routes[1].aliases.some(
            (alias: { scenarioId: string }) => alias.scenarioId === outcome.scenario.id,
          ),
        ),
      ).toBe(false);
      const sharedAlias = result.routes[1].aliases.find((alias: { scenarioId: string }) =>
        result.routes[0].outcomes.some(
          (outcome: { scenario: { id: string } }) => outcome.scenario.id === alias.scenarioId,
        ),
      );
      expect(sharedAlias).toBeDefined();
      const sharedOwner = result.routes[0].outcomes.find(
        (outcome: { scenario: { id: string } }) => outcome.scenario.id === sharedAlias.scenarioId,
      );
      expect(sharedOwner.receipts).toContainEqual(
        expect.objectContaining({
          status: "applied",
          routeId: "r01",
          routePath: "/dashboard",
          url: `${fixture.origin}/api/shared`,
        }),
      );
      for (const entry of result.routes)
        for (const outcome of entry.outcomes) {
          expect(outcome.scenario).toMatchObject({
            routeId: entry.route.id,
            routePath: entry.route.path,
          });
          for (const receipt of outcome.receipts)
            expect(receipt).toMatchObject({ routeId: entry.route.id, routePath: entry.route.path });
          for (const artifact of Object.values(outcome.proof))
            if (typeof artifact === "string")
              expect(artifact).toContain(`/routes/${entry.route.id}/probes/`);
        }
      const r01Proofs = result.routes[0].outcomes.filter(
        (outcome: { proof: { faultedShot: string | null } }) => outcome.proof.faultedShot,
      );
      const r02Proofs = result.routes[1].outcomes.filter(
        (outcome: { proof: { faultedShot: string | null } }) => outcome.proof.faultedShot,
      );
      expect(r01Proofs).toHaveLength(2);
      expect(r02Proofs).toHaveLength(1);
      expect(
        new Set(
          r01Proofs.map(
            (outcome: { proof: { baselineShot: string } }) => outcome.proof.baselineShot,
          ),
        ).size,
      ).toBe(1);
      expect(r02Proofs[0].proof.baselineShot).not.toBe(r01Proofs[0].proof.baselineShot);
      const r01Media = await readdir(join(document.runDir, "routes/r01/probes"), {
        recursive: true,
      });
      const r02Media = await readdir(join(document.runDir, "routes/r02/probes"), {
        recursive: true,
      });
      expect(r01Media.filter((file) => file.endsWith(".png"))).toHaveLength(3);
      expect(r02Media.filter((file) => file.endsWith(".png"))).toHaveLength(2);
      // Discovery and clean replay each use a fresh context (four fresh loads
      // across scan + chaos discovery). Every smoke/proof context then starts
      // fresh and keeps its runtime cookie only for the faulted reload.
      expect(fixture.routeRuntimeStats()).toMatchObject({
        "/dashboard": { fresh: 8, replay: 4 },
        "/reports": { fresh: 6, replay: 2 },
      });
      expect(JSON.stringify(document)).not.toContain("fixture-secret");
    } finally {
      await fixture.close();
    }
  });
});
