import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { writeAtomicScreenshot } from "../src/driver/playwright";

const region = { x: 101, y: 202, width: 303, height: 104 };

describe("atomic screenshot writer", () => {
  it("forwards the exact clip and reports framing and byte size", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tremor-shot-"));
    let received: unknown;
    const page = {
      screenshot: async (options: { path: string }) => {
        received = options;
        writeFileSync(options.path, Buffer.from("png-bytes"));
      },
    };
    const result = await writeAtomicScreenshot(page, dir, 0, { label: "faulted-final", region });
    expect(received).toMatchObject({ clip: region, fullPage: false });
    expect(result.evidence).toMatchObject({ framing: "region", region, byteSize: 9 });
    expect(result.count).toBe(1);
  });

  it("rejects region plus fullPage", async () => {
    await expect(
      writeAtomicScreenshot({ screenshot: async () => {} }, "/tmp", 0, {
        label: "bad",
        region,
        fullPage: true,
      }),
    ).rejects.toThrow("mutually exclusive");
  });

  it("cleans partial output and leaves the canonical counter reusable", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tremor-shot-fail-"));
    const failing = {
      screenshot: async ({ path }: { path: string }) => {
        expect(path).toMatch(/\.png\.tmp-.*\.png$/);
        writeFileSync(path, "partial");
        throw new Error("capture failed");
      },
    };
    await expect(
      writeAtomicScreenshot(failing, dir, 0, { label: "faulted-final", region }),
    ).rejects.toThrow();
    expect(readdirSync(dir)).toEqual([]);
    const success = {
      screenshot: async ({ path }: { path: string }) => writeFileSync(path, "complete"),
    };
    const retried = await writeAtomicScreenshot(success, dir, 0, { label: "faulted-final" });
    expect(retried.evidence.path).toMatch(/001-faulted-final\.png$/);
    expect(existsSync(retried.evidence.path)).toBe(true);
  });
});
