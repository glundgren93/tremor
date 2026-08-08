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

Each run emits one JSON document and writes artifacts under `tremor-runs/` by default. Dashboard, embedded runtimes, MCP tools, and reporting/skill layers are outside this core.
