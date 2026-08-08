import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version";

describe("release version", () => {
  it("matches package metadata", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(packageJson.version);
  });
});
