#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT = resolve(dirname(SCRIPT_PATH), "..");
const SOURCE_ROOT = join(ROOT, "src");
const DEFAULT_BASELINE = join(ROOT, "quality/module-size-baseline.json");
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

export const DEFAULT_POLICY = Object.freeze({
  existingModuleMaxCodeLines: 400,
  newModuleMaxCodeLines: 300,
});

function portablePath(path) {
  return relative(ROOT, path).split(sep).join("/");
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sourceFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    compareText(a.name, b.name),
  )) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...sourceFiles(path));
    else if (SOURCE_EXTENSIONS.has(extname(entry.name)) && !entry.name.endsWith(".d.ts"))
      files.push(path);
  }
  return files;
}

function tokenLines(sourceFile, text) {
  const lines = new Set();
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    sourceFile.languageVariant,
    text,
  );
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    const start = scanner.getTokenPos();
    const end = Math.max(start, scanner.getTextPos() - 1);
    const first = sourceFile.getLineAndCharacterOfPosition(start).line + 1;
    const last = sourceFile.getLineAndCharacterOfPosition(end).line + 1;
    for (let line = first; line <= last; line++) lines.add(line);
  }
  return lines;
}

function isImplementedFunction(node) {
  return (
    (ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node)) &&
    node.body !== undefined
  );
}

function functionName(node, sourceFile) {
  if (node.name) return node.name.getText(sourceFile);
  if (ts.isVariableDeclaration(node.parent) && node.parent.name)
    return node.parent.name.getText(sourceFile);
  const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  return `<anonymous>@${line}`;
}

function functionMetrics(sourceFile, codeLines) {
  const functions = [];
  const visit = (node) => {
    if (isImplementedFunction(node)) {
      const first = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      const last = sourceFile.getLineAndCharacterOfPosition(Math.max(node.getStart(sourceFile), node.end - 1)).line + 1;
      let lines = 0;
      for (const line of codeLines) if (line >= first && line <= last) lines++;
      functions.push({ name: functionName(node, sourceFile), codeLines: lines, line: first });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  functions.sort((a, b) => b.codeLines - a.codeLines || a.line - b.line || compareText(a.name, b.name));
  return functions;
}

function hasExportModifier(statement) {
  return Boolean(
    ts.canHaveModifiers(statement) &&
      ts.getModifiers(statement)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
  );
}

function exportCount(sourceFile) {
  let count = 0;
  for (const statement of sourceFile.statements) {
    if (ts.isExportAssignment(statement)) count++;
    else if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause))
        count += statement.exportClause.elements.length;
      else count++;
    } else if (hasExportModifier(statement)) {
      count += ts.isVariableStatement(statement) ? statement.declarationList.declarations.length : 1;
    }
  }
  return count;
}

export function measureSource(text, path = "module.ts") {
  const kind = path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, kind);
  const lines = tokenLines(sourceFile, text);
  const functions = functionMetrics(sourceFile, lines);
  return {
    codeLines: lines.size,
    functions: functions.length,
    exports: exportCount(sourceFile),
    largestFunction: functions[0] ?? null,
  };
}

export function measureRepository(directory = SOURCE_ROOT) {
  return Object.fromEntries(
    sourceFiles(directory).map((path) => [
      portablePath(path),
      measureSource(readFileSync(path, "utf8"), path),
    ]),
  );
}

export function evaluatePolicy(metrics, baseline, policy = DEFAULT_POLICY) {
  const violations = [];
  const ratchets = [];
  const stale = Object.keys(baseline.files)
    .filter((path) => !(path in metrics))
    .sort(compareText);
  for (const [path, measurement] of Object.entries(metrics)) {
    const previous = baseline.files[path];
    const limit = previous
      ? Math.max(policy.existingModuleMaxCodeLines, previous.codeLines)
      : policy.newModuleMaxCodeLines;
    if (measurement.codeLines > limit)
      violations.push({ path, codeLines: measurement.codeLines, limit, kind: previous ? "existing" : "new" });
    if (previous?.codeLines > policy.existingModuleMaxCodeLines && measurement.codeLines < previous.codeLines)
      ratchets.push({ path, baseline: previous.codeLines, current: measurement.codeLines });
  }
  return { violations, ratchets, stale };
}

function baselineFor(metrics) {
  return {
    version: 1,
    scope: "src/**/*.{ts,tsx,mts,cts}",
    definition: "Unique source lines occupied by non-trivia TypeScript tokens.",
    policy: DEFAULT_POLICY,
    files: Object.fromEntries(
      Object.entries(metrics).map(([path, measurement]) => [path, { codeLines: measurement.codeLines }]),
    ),
  };
}

export function validateBaseline(baseline) {
  if (baseline?.version !== 1 || !baseline.files || typeof baseline.files !== "object")
    throw new Error("Unsupported module-size baseline");
  for (const [name, expected] of Object.entries(DEFAULT_POLICY)) {
    if (!Number.isInteger(baseline.policy?.[name]) || baseline.policy[name] !== expected)
      throw new Error(`Module-size policy ${name} must equal ${expected}`);
  }
  for (const [path, value] of Object.entries(baseline.files)) {
    if (!value || !Number.isInteger(value.codeLines) || value.codeLines < 0)
      throw new Error(`Invalid module-size baseline entry: ${path}`);
  }
  return baseline;
}

function readBaseline(path) {
  try {
    return validateBaseline(JSON.parse(readFileSync(path, "utf8")));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid module-size baseline ${portablePath(path)}: ${reason}`);
  }
}

export function updateBaseline(metrics, previous) {
  const baseline = validateBaseline(previous);
  const result = evaluatePolicy(metrics, baseline, DEFAULT_POLICY);
  if (result.violations.length > 0) {
    const summary = result.violations
      .map((item) => `${item.path} (${item.codeLines} > ${item.limit})`)
      .join(", ");
    throw new Error(`Refusing to baseline module-size regressions: ${summary}`);
  }
  return baselineFor(metrics);
}

function report(metrics, result, policy) {
  const rows = Object.entries(metrics).sort(
    ([pathA, a], [pathB, b]) => b.codeLines - a.codeLines || compareText(pathA, pathB),
  );
  const total = rows.reduce((sum, [, value]) => sum + value.codeLines, 0);
  console.log(
    `Module size: ${rows.length} modules, ${total} code lines; limits existing=${policy.existingModuleMaxCodeLines}, new=${policy.newModuleMaxCodeLines}`,
  );
  console.log("code  funcs exports largest  module");
  for (const [path, value] of rows) {
    const largest = value.largestFunction
      ? `${value.largestFunction.codeLines}:${value.largestFunction.name}`
      : "-";
    console.log(
      `${String(value.codeLines).padStart(4)}  ${String(value.functions).padStart(5)} ${String(value.exports).padStart(7)} ${largest.padStart(7)}  ${path}`,
    );
  }
  for (const item of result.ratchets)
    console.log(`RATCHET ${item.path}: baseline ${item.baseline} -> current ${item.current}`);
  for (const path of result.stale) console.log(`STALE baseline entry: ${path}`);
  for (const item of result.violations)
    console.error(`ERROR ${item.path}: ${item.codeLines} code lines exceeds ${item.kind} limit ${item.limit}`);
}

function parseArguments(argv) {
  const options = { baseline: DEFAULT_BASELINE, json: false, writeBaseline: false };
  for (let index = 0; index < argv.length; index++) {
    const value = argv[index];
    if (value === "--json") options.json = true;
    else if (value === "--write-baseline") options.writeBaseline = true;
    else if (value === "--baseline") {
      const path = argv[++index];
      if (!path) throw new Error("--baseline requires a path");
      options.baseline = resolve(ROOT, path);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  return options;
}

export function run(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const metrics = measureRepository();
  if (options.writeBaseline) {
    if (!existsSync(options.baseline))
      throw new Error(`Cannot update missing baseline: ${portablePath(options.baseline)}`);
    const next = updateBaseline(metrics, readBaseline(options.baseline));
    writeFileSync(options.baseline, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`Wrote ${portablePath(options.baseline)}`);
    return 0;
  }
  const baseline = readBaseline(options.baseline);
  const result = evaluatePolicy(metrics, baseline, DEFAULT_POLICY);
  if (options.json) console.log(JSON.stringify({ metrics, result, policy: DEFAULT_POLICY }, null, 2));
  else report(metrics, result, DEFAULT_POLICY);
  return result.violations.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    process.exitCode = run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
