# Tremor

> A browser chaos CLI for testing how web applications behave when their real dependencies fail or slow down.

[![Distribution checks](https://github.com/glundgren93/tremor/actions/workflows/ci.yml/badge.svg)](https://github.com/glundgren93/tremor/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Tremor watches the network traffic produced by your application, finds repeatable business API requests, injects a controlled fault inside Chrome, and records what changed in the UI.

It produces factual JSON evidence for people, coding agents, and CI systems. Tremor does not assign severity or decide whether an application passed or failed.

## What Tremor does

Given a page such as `https://example.com/dashboard`, Tremor can:

- discover the APIs used while the page loads;
- replay discovery to exclude one-off requests;
- inject a deterministic HTTP 503 or bounded latency fault;
- compare clean and faulted browser state;
- retain screenshots or video only when an applied fault produces a meaningful change;
- emit redacted observations and exact fault receipts as JSON.

Tremor also supports authenticated applications, semantic interaction journeys, and explicit multi-route checks.

## Requirements

- Node.js 20 or 22
- Google Chrome stable
- Linux or macOS

Windows and browsers other than Chrome are not currently supported.

## Install

Run Tremor without installing it globally:

```sh
npx @glundgren93/tremor https://example.com/dashboard
```

Or install the CLI from npm:

```sh
npm install --global @glundgren93/tremor
tremor --version
```

Releases are published from the tagged GitHub Actions workflow using npm trusted publishing. The same validated package is also available as a checksum-attested tarball from [GitHub Releases](https://github.com/glundgren93/tremor/releases) for verified or offline installation:

```sh
curl --fail --location --remote-name https://github.com/glundgren93/tremor/releases/latest/download/tremor.tgz
curl --fail --location --remote-name https://github.com/glundgren93/tremor/releases/latest/download/tremor.tgz.sha256

sha256sum -c tremor.tgz.sha256
# macOS: shasum -a 256 -c tremor.tgz.sha256

npm install --global ./tremor.tgz
```

Upgrade with `npm install --global @glundgren93/tremor@latest`, install a previous version with `@glundgren93/tremor@<version>`, or uninstall with `npm uninstall --global @glundgren93/tremor`.

## Quick start

Run a bounded chaos check against a page:

```sh
tremor https://example.com/dashboard
```

The URL shorthand runs the `chaos` command with safe defaults. Control how many scenarios are probed and how many proof reruns are allowed:

```sh
tremor https://example.com/dashboard --budget 3 --proof-limit 2
```

Use the explicit commands when you want only one phase:

```sh
# List candidate same-origin pages from rendered links (does not visit them)
tremor discover https://example.com/dashboard

# Discover eligible dependencies without applying faults
tremor scan https://example.com/dashboard

# Record clean browser observations
tremor observe https://example.com/dashboard

# Discover, fault, compare, and collect bounded proof
tremor chaos https://example.com/dashboard --budget 3 --proof-limit 2
```

If a page has no eligible dependency, Tremor returns `applicability.status: "not-applicable"`. Static and server-rendered pages can legitimately produce this result.

## How it works

1. **Clean discovery** — Tremor opens the target in an isolated Chrome context and records page traffic.
2. **Replay check** — Discovery runs again so only repeatable dependencies remain eligible.
3. **Safe selection** — Tremor selects replayed business API `GET` requests and rejects unsafe traffic.
4. **Smoke probes** — Cheap fault probes run without screenshots or video.
5. **Proof reruns** — Only applied faults with meaningful deltas are rerun for settled evidence.
6. **JSON output** — Tremor writes observations, classifications, receipts, budgets, and artifact paths.

Default derived faults are deterministic HTTP 503 responses. To test a deterministic 1000ms delay instead:

```sh
tremor chaos https://example.com/dashboard --fault latency --budget 1
```

The delay is applied in the browser. The upstream service receives an ordinary GET; delivery to the page is delayed locally.

## Safety model

Fault interception stays inside the browser. Tremor does not send synthetic 503 responses to the upstream service.

Derived faults target replayed `GET` XHR/fetch business requests only. Tremor fails closed for:

- mutations and unknown request types;
- document, speculative, and embedded-frame traffic;
- telemetry and common analytics traffic;
- unknown cross-origin services and sibling tenants;
- requests that did not appear during clean replay.

A cross-origin API must be labelled `same-site` by Chrome and pass private-suffix-aware domain matching. Explicit presets are restricted to the exact target origin.

Applications can assign side effects to GET, and the browser route guard does not cover WebSockets. Review the target before testing it.

## Authenticated applications

Create an origin-bound profile by signing in through a visible Chrome window:

```sh
tremor auth setup https://example.com/login \
  --profile work \
  --until-url 'https://example.com/app*'
```

Use and manage the profile:

```sh
tremor https://example.com/app --profile work
tremor auth list
tremor auth remove work
```

Profiles are stored with private permissions and loaded into isolated browser contexts. Treat them as secrets. Tremor reports expired login state without exposing cookies, tokens, redirect details, or storage-state paths.

An explicit Playwright storage-state file can be supplied with `--auth-state <file>`.

## Interaction journeys

Use a journey when important API traffic appears only after user interaction:

```json
{
  "version": 1,
  "id": "search",
  "steps": [
    { "id": "query", "type": "fill", "label": "Search", "value": "revenue" },
    { "id": "go", "type": "click", "role": "button", "name": "Search" },
    { "id": "ready", "type": "wait-visible", "role": "status", "name": "Results" },
    { "id": "results", "type": "checkpoint" }
  ]
}
```

Run it with `scan` or `chaos`:

```sh
tremor scan https://example.com/app --journey journey.json
tremor chaos https://example.com/app --journey journey.json --budget 1
```

Journeys support same-origin navigation, semantic fill and click actions, bounded waits, visible-state checks, and checkpoints. Discovery runs in independent clean contexts. Fault interception is armed only for the step and checkpoint that own the selected request.

Selectors, fill values, auth paths, and Playwright diagnostics are excluded from exported journey errors.

## Multiple routes

Pass a complete comma-separated list when you want to check several known routes:

```sh
tremor chaos https://example.com \
  --routes /dashboard,/reports,/settings \
  --budget 3 \
  --proof-limit 2
```

Tremor accepts up to 10 strict same-origin paths. `discover` can list bounded candidate paths from rendered links, but does not crawl, visit, or test them automatically. Smoke and proof budgets are global and allocated fairly across routes. Equivalent dependencies are owned by the first route that observed them; aliases do not receive fabricated outcomes.

## Presets

Use a preset when you want a fixed fault model instead of a derived business API fault:

```sh
tremor chaos https://example.com --preset slow-network --proof-limit 0
```

Available presets:

- `backend-down`
- `slow-network`
- `flaky`
- `timeout-chaos`
- `empty-response`
- `auth-cascade`

Presets remain browser-local, `GET`-only, and restricted to the exact target origin.

## Output

`discover` emits candidate same-origin paths found in rendered anchors without visiting them. Results are bounded to 20 candidates by default; use `--limit <n>` (maximum 100) to change that bound. The output reports `eligibleTotal`, `returned`, `truncated`, occurrence counts, and exclusion totals. Candidates are suggestions only and are never automatically passed to `chaos`; select them explicitly with `--routes`.

Every `scan`, `observe`, `chaos`, or `discover` run emits:

- one bounded JSON document on stdout;
- structured operational logs on stderr;
- a complete redacted `result.json` in the run directory;
- proof media only for eligible changed scenarios.

```sh
tremor https://example.com > result.json
```

Important classifications:

- `changed` — the fault was applied and meaningful observations changed;
- `unchanged` — the fault was applied but no meaningful delta was observed;
- `notApplied` — the selected request did not match or the effect did not fire;
- `failed` — the scenario could not be evaluated safely;
- `not-applicable` — no eligible repeatable dependency was found.

Exit code `0` means execution completed. It is not a resilience pass judgment.

Full results can include conservative receipt-to-region attribution. One applied receipt may map to stable changed UI regions; multiple applied receipts remain explicitly ambiguous rather than being guessed. Raw editable values, locators, text fingerprints, cookies, tokens, and auth paths are not exported.

See [CI and agent contracts](docs/ci-and-agents.md) for the versioned JSON schema, exit semantics, factual comparison adapter, and optional external policy example.

## Useful options

```text
--budget <n>         Smoke scenarios to probe (default: 3)
--proof-limit <n>    Maximum proof reruns (default: 2)
--filter <text>      Restrict discovered endpoint paths
--routes <paths>     Explicit comma-separated route list
--journey <file>     Semantic interaction journey
--profile <name>     Reusable authenticated profile
--fault latency      Use deterministic latency instead of HTTP 503
--viewport <WxH>     Browser viewport (default: 1280x720)
--seed <value>       Deterministic scenario and effect seed
--no-video           Skip proof video
--headed             Show Chrome
--out <dir>          Artifact root (default: tremor-runs)
--full               Print the complete result instead of the digest
```

Run `tremor --help` for the complete command reference.

## Benchmarks and CI

The required benchmark corpus uses deterministic loopback fixtures for static pages, server-rendered pages, public and authenticated SPAs, expired login state, same-site APIs, loading/retry/error states, blank regions, and forbidden traffic. Optional live targets are manual and always require review.

See [benchmarks/README.md](benchmarks/README.md) for the matrix and runner policy.

Release and distribution workflows validate source metadata, Linux browser E2E, package installation, upgrade behavior, checksums, and the packaged CLI before publishing to npm and GitHub. The GitHub Release stays in draft until npm integrity, provenance, and uploaded assets are verified.

## Development

```sh
git clone https://github.com/glundgren93/tremor.git
cd tremor
corepack enable
pnpm install

pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
```

The browser E2E suite requires the Playwright Chrome runtime and system dependencies:

```sh
pnpm exec playwright install --with-deps chrome
```

## Scope

Tremor intentionally does not provide recursive crawling, automatic journey recording, proxy-level faults, WebSocket interception, severity scoring, dashboards, or HTML reports. These can be built as external adapters without changing the factual CLI core.

## License

MIT
