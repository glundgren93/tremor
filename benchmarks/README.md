# Benchmark corpus

`matrix.json` drives every deterministic fixture expectation. Run the packaged local corpus with:

```sh
pnpm build
pnpm benchmark:local benchmark-artifacts
```

The local runner uses private output directories, bounded child output/runtime, loopback-only fixtures, schema and redaction checks, and writes `manifest.json`. The mutation fixture sends an explicit dry-run header/body; the server verifies that declaration, counts attempts, and would increment `mutationStateWrites` for any non-dry-run request. Selected scenarios and receipts separately prove Tremor did not fault the mutation endpoint. `expectationsMatched` and `mismatchReasons` are external harness facts, not Tremor judgments.

Live runs are optional, manual-only, allowlisted, and unauthenticated:

```sh
node benchmarks/run-live.mjs --case example-live --out live-output
```

Production/network variability is **not a regression until reviewed**. Live operational, timeout, and output-limit failures default to `needs-review` with exit 0; `--strict-operational` opts into exit 1.
