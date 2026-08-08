# Tremor CLI

**Version 0.2.0**

Tremor is an agent-agnostic browser resilience and chaos-engineering CLI. It discovers real page-load traffic, injects controlled browser-local faults, and emits factual observations plus fault receipts as machine-readable JSON.

Tremor does not modify remote server state and does not declare whether an application passed or failed. A human, agent, or CI policy interprets the evidence.

## Requirements

- Node.js 20 or newer
- Google Chrome
- macOS or Linux (the current automated coverage targets these environments)

## Install

Install the latest packaged release from GitHub:

```sh
npm install --global https://github.com/glundgren93/tremor/releases/latest/download/tremor.tgz
tremor --version
```

The installed command is `tremor`. The release tarball is built and checksum-attested on the [GitHub Releases](https://github.com/glundgren93/tremor/releases) page. To upgrade later, run the same install command again.

To uninstall:

```sh
npm uninstall --global @glundgren93/tremor
```

### Install from source

```sh
git clone https://github.com/glundgren93/tremor.git
cd tremor
corepack enable
pnpm install
pnpm build
npm link

tremor --version
```

## Quick start

Run the default bounded chaos check:

```sh
tremor https://example.com
```

Control cost and proof generation:

```sh
tremor https://example.com --budget 3 --proof-limit 2
```

The URL shorthand:

1. Records page-load traffic and a clean replay.
2. Selects deterministic, repeatable business API requests.
3. Runs cheap smoke probes without screenshots or video.
4. Reruns only attested behavioral changes to collect proof.

Default derived faults are deterministic 503 responses against `GET` XHR/fetch requests only. Cross-origin requests must be both labelled `same-site` by Chromium and matched to the page through a private-suffix-aware domain check. Unknown cross-origin, third-party, speculative, telemetry, mutation, and document requests fail closed.

## Commands

```sh
# Discover endpoints and generated scenarios; applies no faults
tremor scan https://example.com

# Record factual visual/content observations
tremor observe https://example.com

# Explicit chaos command (same behavior as the URL shorthand)
tremor chaos https://example.com --budget 3 --proof-limit 2

# Show all options
tremor --help
```

Useful options:

```sh
--budget <n>         Number of smoke scenarios (default: 3)
--proof-limit <n>    Maximum proof reruns (default: 2; 0 disables proof)
--filter <text>      Restrict discovered endpoint paths
--viewport <WxH>     Browser viewport (default: 1280x720)
--headed             Show Chrome
--no-video           Skip proof video
--seed <value>       Deterministic scenario/effect seed
--out <dir>          Artifact root (default: tremor-runs)
--full               Print the complete result instead of the digest
```

`--scenarios` remains a compatibility alias for `--budget`; do not supply both.

## Presets

Use an explicit preset when you want a fixed fault model rather than a derived API fault:

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

Presets remain browser-local and `GET`-only. Preset routing is restricted to the exact target origin.

## Authenticated applications

Create a reusable profile. Chrome opens so you can sign in manually:

```sh
tremor auth setup https://example.com/login \
  --profile work \
  --until-url 'https://example.com/app*'
```

Reuse and manage it:

```sh
tremor https://example.com/app --profile work
tremor auth list
tremor auth remove work
```

Profiles are origin-bound, stored with private permissions, and loaded into isolated browser contexts. Treat them as secrets. `--auth-state <file>` remains available for explicit Playwright storage-state files.

## Output

Every `scan`, `observe`, or `chaos` run writes:

- One bounded JSON document to stdout.
- Structured logs to stderr.
- A complete redacted `result.json` under `tremor-runs/` (or `--out`).
- Screenshots/video only for proof-eligible changed scenarios.

Example classifications:

- `changed`: the fault was applied and factual observations changed.
- `unchanged`: the fault was applied but Tremor observed no meaningful delta.
- `notApplied`: the selected request did not match or a probabilistic effect did not fire.
- `failed`: the scenario could not be evaluated safely.
- `applicability.status: "not-applicable"`: no safe, repeatable page-load API target was observed.

Exit code `0` means execution completed, not that the application passed a resilience judgment.

To capture only the JSON digest:

```sh
tremor https://example.com > result.json
```

Logs remain on stderr.

## Current scope

Version 0.2.0 intentionally focuses on:

- Chromium/Google Chrome
- Page-load journeys
- Browser-local `GET` XHR/fetch fault interception
- Deterministic 503 derived faults
- Secure reusable auth profiles
- Fault receipts and bounded proof artifacts

Static or server-rendered pages without repeatable page-load API traffic may correctly be `not-applicable`. Interactive multi-step journey recording, other browsers, proxy-level faults, severity scoring, and dashboard/reporting layers are outside the current core.

## Development

```sh
corepack enable
pnpm install
pnpm test
pnpm test:e2e
pnpm typecheck
pnpm lint
pnpm build
pnpm --silent cli --help
```

The automated suite covers deterministic selection, browser-attested same-site safety, private hosting suffixes, replayability, auth reuse, exact fault receipts, proof artifacts, redaction, and static-page inapplicability.

## License

MIT
