# Tremor CLI

**Published version 0.2.0; declarative journeys and deterministic latency faults are unreleased on the current development branch.**

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

On the current unreleased branch, select one explicit latency fault:

```sh
tremor chaos https://example.com --fault latency --budget 1
```

This delays one eligible, replayed, same-origin (or browser-attested same-site) business API `GET` XHR/fetch request by exactly 1000ms. Latency is browser-local; the upstream server still receives an ordinary GET. All latency calculations are capped at 3000ms. Matched and applied receipts include `scenarioId`, `faultId`, `faultType: "latency"`, and `delayMs: 1000`, with no `httpStatus`. Timeout, corruption, and other fault types are not yet productized through `--fault`.

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

## Bounded multi-route discovery

Use `--routes /dashboard,/reports,/settings` with `scan` or derived `chaos` for a complete explicit list (maximum 10). Entries resolve from the positional URL origin and cannot contain queries, fragments, whitespace, schemes, or cross-origin forms. Routes are not crawled. Multi-route mode cannot be combined with `observe`, `--journey`, or `--preset`. Equivalent derived scenarios are owned by the first route that observed them; this representative deduplication does not imply the alias route was tested.

## Declarative journeys (JSON v1)

Use `--journey <file>` with `scan` or `chaos` to discover and fault API traffic triggered by semantic interactions:

```json
{"version":1,"id":"search","steps":[
  {"id":"query","type":"fill","label":"Search","value":"revenue"},
  {"id":"go","type":"click","role":"button","name":"Search"},
  {"id":"ready","type":"wait-visible","role":"status","name":"Results"},
  {"id":"results","type":"checkpoint"}
]}
```

Supported actions are `navigate` (same-origin absolute `path`), `fill`, `click`, semantic `wait-visible`, bounded `wait`, and `checkpoint`. Targets use exactly one of `role`+`name`, `label`, or `testId`; submit controls are rejected. A click must remain at its current URL unless it declares an exact same-origin `expectPath`. Explicit navigation must finish at the declared URL. Cross-origin navigation and non-GET/HEAD/OPTIONS requests are blocked.

Discovery runs the journey twice in independent clean browser contexts and associates requests with their triggering step and subsequent checkpoint. Fault replay arms immediately before that triggering step and stops at the checkpoint, so earlier occurrences stay clean and later requests are not run. `--journey` cannot be combined with `observe` or `--preset`.

Journey failures use canned, secret-safe diagnostics: selectors, fill values, auth-state paths, and Playwright call logs are not included. Journeys cannot eliminate the possibility that an application assigns side effects to GET, and this browser-route guard does not cover WebSockets; review targets accordingly.

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

Profiles are origin-bound, stored with private permissions, and loaded into isolated browser contexts. Treat them as secrets. If a selected profile redirects to a login page, Tremor exits clearly and tells you to refresh it with `tremor auth setup ... --profile <name>`. `--auth-state <file>` remains available for explicit Playwright storage-state files; expired raw state receives the equivalent recreate-and-retry diagnostic.

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
- `applicability.status: "not-applicable"`: no safe, repeatable page-load or declared-journey API target was observed.

Exit code `0` means execution completed, not that the application passed a resilience judgment.

To capture only the JSON digest:

```sh
tremor https://example.com > result.json
```

Logs remain on stderr.

## Current scope

Published version 0.2.0 focuses on the core below; interactive declarative journeys are unreleased work on the current development branch:

- Chromium/Google Chrome
- Interactive declarative JSON journeys
- Browser-local `GET` XHR/fetch fault interception
- Deterministic 503 derived faults
- Secure reusable auth profiles
- Fault receipts and bounded proof artifacts

Static or server-rendered pages without repeatable page-load or declared-journey API traffic may correctly be `not-applicable`. Broader automatic journey recording/crawling, other browsers, proxy-level faults, severity scoring, and dashboard/reporting layers are outside the current core.

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

### Proof evidence framing

Proof runs keep one settled full-viewport baseline and one `faulted-final` image. The final image is cropped only when every changed semantic fact maps to one stable, unique, mostly-visible semantic container; otherwise it remains a viewport capture. Result JSON records the successful framing, exact viewport-CSS-pixel region when cropped, bounded region identity/kind, fallback reason, and byte size. Smoke runs do not create screenshots or video.

### Receipt-to-region attribution

Each full `ProbeOutcome` has `attributions`, a versioned factual contract referencing an applied receipt by its array index plus scenario/fault/method/timestamp fields. Attribution does not duplicate the receipt URL; consumers resolve it through `receiptIndex`. With one applied receipt, stable changed semantic regions contain bounded before/after counts and explicit changed metric names, ordered by hashed `regionId`. Multiple applied receipts are `ambiguous` with no guessed region mapping; absent or unstable region changes are `no-region-delta`. The comparison uses isolated baseline/faulted state only and does not infer causality from timing.

Region metrics expose only bounded counts (safe-text character length, rows/items/controls/errors/skeletons/blanks). Region text and combined fingerprints use a random per-probe HMAC key shared only by baseline and faulted capture; the key is never serialized. Raw locators, fingerprints, editable values, selected option text, placeholders, and accessible names are excluded. Accessible labels/text summaries and numeric confidence remain deferred unless a future secret-safe schema is designed. Attribution carries no severity or pass/fail judgment. HTML reports, overlays, and heatmaps are also deferred.

## License

MIT
