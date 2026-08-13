import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Driver } from "../src/driver/driver";
import { ok } from "../src/types/result";

const createPlaywrightDriver = vi.fn();
vi.mock("../src/driver/playwright", () => ({ createPlaywrightDriver }));

const { commandDiscover } = await import("../src/cli/commands");

const options = {
  url: "https://app.test/home",
  runDir: "/tmp/tremor-discover",
  headless: true,
  waitUntil: "load" as const,
  timeoutMs: 1_000,
  viewport: { width: 800, height: 600 },
  video: true,
  authSelection: { kind: "none" as const },
};

describe("commandDiscover", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads and evaluates the page once without navigating candidates or recording media", async () => {
    const navigate = vi
      .fn()
      .mockResolvedValue(ok({ url: options.url, status: 200, durationMs: 1 }));
    const waitForIdle = vi.fn().mockResolvedValue(ok(undefined));
    const evaluate = vi.fn().mockResolvedValue(
      ok([
        {
          href: "https://app.test/reports",
          rawHref: "/reports",
          rendered: true,
          downloadable: false,
        },
      ]),
    );
    const recordingPath = vi.fn().mockResolvedValue("unexpected.webm");
    const close = vi.fn().mockResolvedValue(undefined);
    const driver = {
      navigate,
      waitForIdle,
      currentUrl: () => options.url,
      evaluate,
      recordingPath,
      close,
    } as unknown as Driver;
    createPlaywrightDriver.mockResolvedValue(ok(driver));

    const result = await commandDiscover(options, 20);

    expect(result).toEqual(
      ok({
        candidates: [{ path: "/reports", occurrences: 1 }],
        eligibleTotal: 1,
        returned: 1,
        truncated: false,
        routeTestLimit: 10,
        excluded: {
          crossOrigin: 0,
          unsafeScheme: 0,
          credentials: 0,
          queryOrFragment: 0,
          invalidRoute: 0,
          current: 0,
          nonRendered: 0,
          downloadOrAsset: 0,
          actionLike: 0,
        },
      }),
    );
    expect(createPlaywrightDriver).toHaveBeenCalledWith(
      expect.objectContaining({ url: options.url, recordVideo: false }),
    );
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(options.url, { waitUntil: "load" });
    expect(waitForIdle).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(recordingPath).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops before DOM evaluation when the authenticated navigation expires", async () => {
    const navigate = vi
      .fn()
      .mockResolvedValue(ok({ url: "https://app.test/login", status: 200, durationMs: 1 }));
    const evaluate = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const driver = {
      navigate,
      waitForIdle: vi.fn().mockResolvedValue(ok(undefined)),
      currentUrl: () => "https://app.test/login",
      evaluate,
      close,
    } as unknown as Driver;
    createPlaywrightDriver.mockResolvedValue(ok(driver));

    const result = await commandDiscover(
      { ...options, authSelection: { kind: "profile", name: "work" } },
      20,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain('profile "work" appears expired');
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(evaluate).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
