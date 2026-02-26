# Tremor

Chaos engineering for frontends. Tremor launches a browser, captures your app's network traffic, injects faults (errors, timeouts, corrupted data), and generates a resilience report with screenshots and a score.

It uses a Claude-powered agent to intelligently explore your app, generate targeted fault scenarios, and evaluate how the UI responds — all from a web dashboard.

Built with the [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk) and [Playwright](https://playwright.dev).

## Quick start

```bash
git clone https://github.com/glundgren93/tremor.git
cd tremor
pnpm install
pnpm dev
```
Open http://localhost:5173, enter a URL, and start testing.

## How it works

1. **Launch** — Tremor opens a Playwright browser and navigates to your app.
2. **Capture** — As the page loads, all network traffic is recorded. Duplicate endpoints are collapsed (e.g. `/api/users/123` and `/api/users/456` become `/api/users/*`).
3. **Generate** — Captured traffic is analyzed to build targeted fault scenarios. Auth endpoints and mutations (POST/PUT/DELETE) are prioritized.
4. **Test** — The agent applies faults one at a time, reloads the page, and observes the result. Scenarios run in parallel across multiple browser tabs.
5. **Report** — Each finding is rated by severity with an auto-captured screenshot. A markdown report with a resilience score is generated at the end.

## What it tests

### Built-in presets

| Preset | What it simulates |
|---|---|
| `backend-down` | 100% 503 Service Unavailable on all API requests |
| `slow-3g` | 2-5s latency on all requests |
| `flaky` | 20% random 500 errors |
| `timeout-chaos` | 30% of requests time out after 5s |
| `peak-load` | Random latency up to 5s |
| `rate-limited` | 50% of requests return 429 Too Many Requests |

### Auto-generated scenarios

Tremor analyzes your app's actual network traffic and generates targeted fault scenarios:

- **Error responses** — 500, 503, 404, 401, 429 for each endpoint
- **Slow responses** — latency spikes (3s and 10s) on data endpoints
- **Timeouts** — requests that hang and never resolve
- **Empty responses** — valid status but empty/null body
- **Corrupted data** — nullified fields in JSON responses

### Severity ratings

Each finding is rated by how the UI handles the fault:

- **Critical** — app crashes, goes blank, or becomes unusable
- **Major** — broken functionality, missing data with no error message
- **Minor** — cosmetic issues, poor error wording
- **Good** — graceful handling with proper error states

## Dashboard

The dashboard provides:

- **Live screencast** of the Playwright browser as it tests your app
- **Scenario selection** — choose which generated scenarios to run, or use presets
- **Real-time findings** — watch findings appear as the agent discovers issues
- **Agent activity** — see what the agent is thinking and which tools it's calling
- **Report viewer** — browse past reports with screenshots and scores
- **Video recordings** — per-scenario video capture of each test

## Authenticated apps

1. Check "Requires Login" before starting — Tremor opens a visible browser window.
2. Log in manually in the browser.
3. Click "Auth Ready" in the dashboard. The session is saved automatically.
4. Subsequent runs restore the session without re-authenticating.

## Prerequisites

- **Node.js 20+**
- **pnpm**

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `TREMOR_MODEL` | `haiku` | Claude model to use for the agent |
| `PORT` | `3000` | Dashboard server port |

## Development

```bash
pnpm dev           # Build + start server + Vite dev server
pnpm dev:ui        # Vite dev server only
pnpm build         # Build everything (tsdown + vite)
pnpm test          # Run tests (vitest)
pnpm test:watch    # Watch mode
pnpm lint          # Biome check
pnpm lint:fix      # Auto-fix
pnpm typecheck     # tsc --noEmit
```

## Architecture

```
Browser → Dashboard (React) ←WebSocket→ Server (Node.js) → Orchestrator → Agent (Claude) → Playwright
```

- **`src/dashboard/server.ts`** — HTTP + WebSocket server, serves the dashboard and streams live data.
- **`src/dashboard/orchestrator.ts`** — Manages the test lifecycle: setup, scenario generation, parallel agent workers, and report generation.
- **`src/dashboard/agent.ts`** — Agent loop using the Claude Agent SDK. Each worker runs an independent agent with access to browser, network, fault, and reporting tools.
- **`src/tools/`** — Tool implementations: browser control, network capture, fault injection, device emulation, performance metrics, and reporting.
- **`src/core/`** — Pure logic: chaos effects, URL matching, scenario generation, report generation, Web Vitals. Fully unit-tested.

## License

[MIT](LICENSE)
