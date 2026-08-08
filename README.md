# Tremor CLI

Tremor is an agent-agnostic browser observation and chaos-engineering CLI. The shipping core is CLI-first: it captures traffic, observes pages, and probes controlled fault scenarios while preserving machine-readable results on stdout and structured logs on stderr.

## Commands

```sh
pnpm build
pnpm exec tremor --help
pnpm exec tremor scan https://example.com
pnpm exec tremor observe https://example.com
pnpm exec tremor chaos https://example.com
```

Each run emits one JSON document and writes artifacts under `tremor-runs/` by default.

### Authentication profiles

```sh
tremor auth setup https://example.com/login --profile work
tremor auth setup https://example.com/login --profile work --until-url https://example.com/app*
tremor auth list
tremor scan https://example.com --profile work
```

Profiles are stored securely under the Tremor config directory. Treat authenticated browser sessions as secrets; do not use bearer credentials in URLs or logs. `--auth-state` remains available for explicit advanced storage-state files.

Dashboard, embedded runtimes, MCP tools, and reporting/skill layers are outside this core.
