# CI and agent contracts

The draft 2020-12 schema is checked in at [`schemas/cli-envelope-v1.schema.json`](../schemas/cli-envelope-v1.schema.json), with ID `https://github.com/glundgren93/tremor/schemas/cli-envelope-v1.schema.json`. See the [evolution policy](../schemas/README.md): v1 changes are additive; breaking changes use a new schema version and file.

## Process contract

Successful stdout is one envelope with `schemaVersion`, `command`, `url`, `runDir`, and `result`. Without `--full`, `result` is a bounded digest and `full` is the absolute path to the existing private (`0600`) complete `result.json`. Persisted and `--full` envelopes contain the full result and never a `full` indirection. Digests exclude captured response bodies; route and legacy totals include stable `total`/`omitted` counts. Errors are `{schemaVersion:1,error,...}`.

Exact exits are: **0** execution completed (including changed, unchanged, and not-applicable); **1** operational execution/auth failure; **2** invalid usage. Logs go only to stderr. Core output is factual: Tremor never declares resilience pass/fail, severity, or release fitness.

```sh
# not-applicable is data, not command failure
status=$(jq -r '.result.applicability.status // "route-specific"' stdout.json)
if [ "$status" = not-applicable ]; then echo 'No eligible fixture target'; fi
jq -e '.schemaVersion == 1 and .command == "chaos"' result.json >/dev/null
```

For routes, branch per route: `jq -r '.result.routes[] | [.route.id,.applicability.status] | @tsv' result.json`. Route artifacts retain route IDs/paths and ownership aliases. Proof is a bounded second lifecycle after smoke: `budget.proof` and proof paths/counts describe what was collected; missing proof is represented by null paths, not inferred. Upload `result.json` plus referenced proof images/video, never auth state.

Redaction recursively precedes stdout and persistence, but artifacts and URLs remain potentially sensitive; use private retention/access settings and review uploads. Storage state is a secret: decode a base64 secret to a `chmod 600` temporary file outside artifact directories, never echo or archive it, bind it to the intended origin, and refresh it when login expires.

## Agent workflow and external interpretation

1. Run the CLI and retain stdout, stderr, exit, and the private run directory.
2. Validate stdout and persisted JSON with Ajv 2020.
3. Branch on applicability and inspect factual totals/receipts/attributions.
4. Resolve `full` only from a digest and verify it remains inside the expected run directory.
5. Apply an explicitly configured external policy if a release decision is required.

[`compare-results.mjs`](../examples/ci/compare-results.mjs) reports only factual count deltas. [`evaluate-policy.mjs`](../examples/ci/evaluate-policy.mjs) is visibly external and uses [`policy.example.json`](../examples/ci/policy.example.json); its exit 1 is the configured policy's decision, not a core judgment. JUnit and SARIF inherently require a pass/fail or severity mapping, so they require such an external policy and are intentionally not raw-core formats.

The runnable [workflow example](../.github/workflows/tremor-example.yml) uses only local fixture tokens and uploads result/proof artifacts with `if: always()`.
