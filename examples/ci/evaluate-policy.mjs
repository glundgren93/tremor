#!/usr/bin/env node
import { readFile } from "node:fs/promises";
function stop(message) { process.stderr.write(`${message}\nusage: evaluate-policy.mjs <result.json> [policy.json]\n`); process.exit(2); }
function outcomes(result) { return result.mode === "routes" ? (result.routes ?? []).flatMap((r) => r.outcomes ?? []) : (result.outcomes ?? []); }
try {
  if (process.argv.length < 3 || process.argv.length > 4) stop("invalid arguments");
  const envelope = JSON.parse(await readFile(process.argv[2], "utf8"));
  const policy = JSON.parse(await readFile(process.argv[3] ?? new URL("./policy.example.json", import.meta.url), "utf8"));
  if (envelope?.schemaVersion !== 1 || envelope.command !== "chaos" || !envelope.result || envelope.full) throw new Error("input must be a persisted schemaVersion 1 chaos envelope");
  if (policy?.policyVersion !== 1 || typeof policy.allowNotApplicable !== "boolean" || !Number.isInteger(policy.maxOperationalFailures) || policy.maxOperationalFailures < 0 || !(policy.maxChanged === null || (Number.isInteger(policy.maxChanged) && policy.maxChanged >= 0))) throw new Error("invalid policy");
  const all = outcomes(envelope.result).filter(Boolean);
  const observed = { changed: 0, operationalFailures: 0, notApplicable: 0 };
  for (const outcome of all) {
    if (outcome.error || (outcome.receipts ?? []).some((r) => r.status === "error")) observed.operationalFailures++;
    else if ((outcome.appliedCount ?? 0) > 0 && ((outcome.appeared?.length ?? 0) || (outcome.disappeared?.length ?? 0))) observed.changed++;
  }
  const applicability = envelope.result.mode === "routes" ? (envelope.result.routes ?? []).map((r) => r.applicability) : [envelope.result.applicability];
  observed.notApplicable = applicability.filter((a) => a?.status === "not-applicable").length;
  const reasons = [];
  if (!policy.allowNotApplicable && observed.notApplicable) reasons.push("not-applicable is disallowed by configured policy");
  if (observed.operationalFailures > policy.maxOperationalFailures) reasons.push("operational failures exceed configured maximum");
  if (policy.maxChanged !== null && observed.changed > policy.maxChanged) reasons.push("changed count exceeds configured maximum");
  const decision = reasons.length ? "reject" : "accept";
  process.stdout.write(`${JSON.stringify({ policyVersion: 1, observed, policy: { allowNotApplicable: policy.allowNotApplicable, maxOperationalFailures: policy.maxOperationalFailures, maxChanged: policy.maxChanged }, decision, reasons }, null, 2)}\n`);
  process.exitCode = reasons.length ? 1 : 0;
} catch (error) { stop(error instanceof Error ? error.message : "invalid input"); }
