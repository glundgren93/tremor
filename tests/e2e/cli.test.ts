import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { saveProfile } from "../../src/auth/profiles";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

async function startFixture(options: { expireJourneyAfterDiscovery?: boolean } = {}): Promise<{
  origin: string;
  sameSiteOrigin: string;
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
    response.end(`<!doctype html>
      <html><body><h1>Account</h1><div id="user">Loading</div>
      <script>
        fetch('/api/user?access_token=sentinel-query')
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
    journeyStats: () => ({
      ...journeyCounts,
      selectedStatuses: [...journeyCounts.selectedStatuses],
      markers: [...journeyMarkers],
    }),
    navigationStats: () => ({
      crossOrigin: crossOriginDocuments,
      sameOrigin: sameOriginDocuments,
    }),
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

afterEach(async () => {
  delete process.env.TREMOR_HOME;
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("built Tremor CLI", () => {
  it("advertises the built declarative journey option", async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ["dist/cli/main.mjs", "--help"],
      { cwd: process.cwd() },
    );
    expect(`${stdout}${stderr}`).toContain("--journey <file>");
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
      const persisted = `${stdout}\n${full}`;
      expect(persisted).not.toContain("fixture-secret");
      expect(persisted).not.toContain("sentinel-query");
      expect(persisted).not.toContain("sentinel-response");
    } finally {
      await fixture.close();
    }
  });
});
