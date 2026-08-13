import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const launch = vi.fn();
const saveProfile = vi.fn();

vi.mock("playwright", () => ({ chromium: { launch } }));
vi.mock("../src/auth/profiles", () => ({
  listProfiles: vi.fn(),
  removeProfile: vi.fn(),
  saveProfile,
  untilUrlMatches: vi.fn(() => true),
}));

const { authCommand } = await import("../src/cli/auth-command");

describe("auth setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("launches installed stable Chrome instead of bundled Chromium", async () => {
    const page = { goto: vi.fn(), url: vi.fn(() => "https://app.test/home") };
    const context = {
      newPage: vi.fn().mockResolvedValue(page),
      storageState: vi.fn().mockResolvedValue({ cookies: [] }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      newContext: vi.fn().mockResolvedValue(context),
      close: vi.fn().mockResolvedValue(undefined),
    };
    launch.mockResolvedValue(browser);
    saveProfile.mockResolvedValue({ name: "work" });

    await authCommand([
      "setup",
      "https://app.test/login",
      "--profile",
      "work",
      "--until-url",
      "https://app.test/home",
    ]);

    expect(launch).toHaveBeenCalledWith({ headless: false, channel: "chrome" });
    expect(page.goto).toHaveBeenCalledWith("https://app.test/login");
    expect(saveProfile).toHaveBeenCalledWith("work", "https://app.test/login", { cookies: [] });
    expect(context.close).toHaveBeenCalledTimes(1);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
