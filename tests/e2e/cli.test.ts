import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { saveProfile } from "../../src/auth/profiles";

const execFileAsync = promisify(execFile);
const temporaryPaths: string[] = [];

async function startFixture(): Promise<{
  origin: string;
  sameSiteOrigin: string;
  close(): Promise<void>;
}> {
  let sameSiteApiOrigin = "";
  const apiServer = http.createServer((request, response) => {
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
