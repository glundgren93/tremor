import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  evaluatePolicy,
  measureSource,
  updateBaseline,
  validateBaseline,
} from "../scripts/module-size.mjs";

describe("module size measurement", () => {
  it("counts token-bearing lines, implemented functions, and top-level exports", () => {
    const measurement = measureSource(`
// Comments and blank lines are excluded.
export const value = 1;

export function first(flag: boolean) {
  if (flag) return 1;
  return 0;
}
const second = () => 2;
export { second };
`);

    expect(measurement).toEqual({
      codeLines: 7,
      functions: 2,
      exports: 3,
      largestFunction: { name: "first", codeLines: 4, line: 5 },
    });
  });

  it("rejects malformed or loosened baseline policies", () => {
    expect(() => validateBaseline({ version: 1, policy: {}, files: {} })).toThrow(
      "existingModuleMaxCodeLines must equal 400",
    );
    expect(() =>
      validateBaseline({
        version: 1,
        policy: DEFAULT_POLICY,
        files: { "src/broken.ts": { codeLines: -1 } },
      }),
    ).toThrow("Invalid module-size baseline entry");
  });

  it("applies baseline limits to existing modules and stricter limits to new modules", () => {
    const result = evaluatePolicy(
      {
        "src/large.ts": {
          codeLines: 420,
          functions: 1,
          exports: 1,
          largestFunction: null,
        },
        "src/regressed.ts": {
          codeLines: 401,
          functions: 1,
          exports: 1,
          largestFunction: null,
        },
        "src/new.ts": {
          codeLines: 301,
          functions: 1,
          exports: 1,
          largestFunction: null,
        },
      },
      {
        files: {
          "src/large.ts": { codeLines: 450 },
          "src/regressed.ts": { codeLines: 300 },
          "src/removed.ts": { codeLines: 10 },
        },
      },
      DEFAULT_POLICY,
    );

    expect(result.violations).toEqual([
      { path: "src/regressed.ts", codeLines: 401, limit: 400, kind: "existing" },
      { path: "src/new.ts", codeLines: 301, limit: 300, kind: "new" },
    ]);
    expect(result.ratchets).toEqual([{ path: "src/large.ts", baseline: 450, current: 420 }]);
    expect(result.stale).toEqual(["src/removed.ts"]);
  });

  it("refuses to rewrite the baseline when current modules exceed their limits", () => {
    expect(() =>
      updateBaseline(
        {
          "src/regressed.ts": {
            codeLines: 401,
            functions: 1,
            exports: 1,
            largestFunction: null,
          },
        },
        {
          version: 1,
          policy: DEFAULT_POLICY,
          files: { "src/regressed.ts": { codeLines: 300 } },
        },
      ),
    ).toThrow("Refusing to baseline module-size regressions");
  });
});
