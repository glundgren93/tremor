#!/usr/bin/env node
import { readFile } from "node:fs/promises";

function usage(message) {
  process.stderr.write(`${message}\nusage: compare-results.mjs <previous-result.json> <current-result.json>\n`);
  process.exit(2);
}
function zero() { return { changed: 0, unchanged: 0, notApplied: 0, failed: 0, applicable: 0, notApplicable: 0, routes: 0 }; }
function add(a, b) { for (const key of Object.keys(a)) a[key] += b[key] ?? 0; return a; }
function classify(outcomes = []) {
  const counts = zero();
  for (const outcome of outcomes) {
    if (!outcome) continue;
    if (outcome.error || (outcome.receipts ?? []).some((r) => r.status === "error")) counts.failed++;
    else if ((outcome.appliedCount ?? 0) === 0) counts.notApplied++;
    else if ((outcome.appeared?.length ?? 0) || (outcome.disappeared?.length ?? 0)) counts.changed++;
    else counts.unchanged++;
  }
  return counts;
}
function counts(envelope) {
  if (envelope?.schemaVersion !== 1 || envelope.command !== "chaos" || !envelope.result || envelope.full) throw new Error("inputs must be persisted schemaVersion 1 chaos envelopes");
  const result = envelope.result;
  const value = zero();
  if (result.mode === "routes") {
    value.routes = result.routes?.length ?? 0;
    for (const route of result.routes ?? []) {
      add(value, classify(route.outcomes));
      route.applicability?.status === "not-applicable" ? value.notApplicable++ : value.applicable++;
    }
  } else {
    add(value, classify(result.outcomes));
    result.applicability?.status === "not-applicable" ? value.notApplicable++ : value.applicable++;
  }
  return value;
}
try {
  if (process.argv.length !== 4) usage("invalid arguments");
  const [previous, current] = await Promise.all(process.argv.slice(2).map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const before = counts(previous), after = counts(current);
  const delta = Object.fromEntries(Object.keys(before).sort().map((key) => [key, after[key] - before[key]]));
  process.stdout.write(`${JSON.stringify({ comparisonVersion: 1, previous: before, current: after, delta }, null, 2)}\n`);
} catch (error) { usage(error instanceof Error ? error.message : "invalid input"); }
