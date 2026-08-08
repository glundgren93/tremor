# Tremor CLI

Tremor is an agent-agnostic browser observation and chaos-engineering CLI. The shipping core is CLI-first: it captures traffic, observes pages, and probes controlled fault scenarios while preserving machine-readable results on stdout and structured logs on stderr.

## Quick start

```sh
pnpm install
pnpm build
pnpm exec tremor https://example.com
```

The URL shorthand is the default safe chaos run. It discovers first-party `GET` XHR/fetch endpoints, selects deterministic 503 scenarios across distinct endpoints, performs a cheap smoke pass, then reruns only attested deltas for proof:

```sh
pnpm exec tremor https://example.com --budget 3 --proof-limit 2
```

Smoke probes do not record video or screenshots. Proof reruns capture baseline/faulted screenshots and video unless `--no-video` is set. Scenarios where the fault was not applied, produced no delta, or failed do not receive proof artifacts.

Explicit commands remain available:

```sh
pnpm exec tremor scan https://example.com
pnpm exec tremor observe https://example.com
pnpm exec tremor chaos https://example.com
pnpm exec tremor --help
```

`--scenarios` is a compatibility alias for `--budget`; do not supply both. `--proof-limit 0` disables proof reruns.

Every command emits exactly one bounded JSON document on stdout and structured logs on stderr. Full redacted results and proof files are written under `tremor-runs/` by default. Exit code `0` means execution completed, not that the app passed a resilience judgment; Tremor emits factual observations and receipts for the calling agent to interpret.

### Authentication profiles

```sh
tremor auth setup https://example.com/login --profile work
tremor auth setup https://example.com/login --profile work --until-url https://example.com/app*
tremor auth list
tremor scan https://example.com --profile work
```

Profiles are stored securely under the Tremor config directory. Treat authenticated browser sessions as secrets; do not use bearer credentials in URLs or logs. `--auth-state` remains available for explicit advanced storage-state files.

Dashboard, embedded runtimes, MCP tools, and reporting/skill layers are outside this core.
