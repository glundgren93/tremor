# Tremor CLI

Tremor is an agent-agnostic browser observation and chaos-engineering CLI. The shipping core is CLI-first: it captures traffic, observes pages, and probes controlled fault scenarios while preserving machine-readable results on stdout and structured logs on stderr.

## Quick start

```sh
pnpm install
pnpm build
pnpm --silent cli https://example.com
```

The URL shorthand is the default safe chaos run. It discovers first-party `GET` XHR/fetch endpoints, selects deterministic 503 scenarios across distinct endpoints, performs a cheap smoke pass, then reruns only attested deltas for proof:

```sh
pnpm --silent cli https://example.com --budget 3 --proof-limit 2
```

Smoke probes do not record video or screenshots. Proof reruns capture baseline/faulted screenshots and video unless `--no-video` is set. Scenarios where the fault was not applied, produced no delta, or failed do not receive proof artifacts. If page load produces no exact-origin `GET` XHR/fetch API request, the run completes with `applicability.status: "not-applicable"` and suggests an explicit page-level preset instead of treating the absence of a safe target as an execution error.

Explicit commands remain available:

```sh
pnpm --silent cli scan https://example.com
pnpm --silent cli observe https://example.com
pnpm --silent cli chaos https://example.com
pnpm --silent cli --help
```

`--scenarios` is a compatibility alias for `--budget`; do not supply both. `--proof-limit 0` disables proof reruns.

Every scan, observe, or chaos command emits exactly one bounded JSON document on stdout and structured logs on stderr. Full redacted results and proof files are written under `tremor-runs/` by default. Auth management commands emit one direct metadata JSON document and intentionally do not create run directories. Exit code `0` means execution completed, not that the app passed a resilience judgment; Tremor emits factual observations and receipts for the calling agent to interpret.

### Authentication profiles

```sh
tremor auth setup https://example.com/login --profile work
tremor auth setup https://example.com/login --profile work --until-url https://example.com/app*
tremor auth list
tremor scan https://example.com --profile work
```

Profiles are stored securely under the Tremor config directory. Treat authenticated browser sessions as secrets; do not use bearer credentials in URLs or logs. `--auth-state` remains available for explicit advanced storage-state files.

## Development

Tremor currently uses an installed Google Chrome channel.

```sh
pnpm test
pnpm test:e2e   # builds the CLI and runs the authenticated real-browser fixture
pnpm typecheck
pnpm lint
pnpm build
```

The E2E fixture verifies profile reuse, exact fault application receipts, smoke-to-proof reruns, screenshot/video artifacts, and secret-free stdout/result files.

Dashboard, embedded runtimes, MCP tools, and reporting/skill layers are outside this core.
