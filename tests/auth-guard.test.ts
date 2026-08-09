import { describe, expect, it } from "vitest";
import { authGuard } from "../src/auth/guard";
import { sanitizeBrowserError } from "../src/driver/playwright";

describe("authGuard", () => {
  const target = "https://app.example.test/dashboard";
  it("detects cross-origin redirects for selected auth", () => {
    const result = authGuard(
      target,
      "https://login.example.test/u/login?code=secret&state=secret",
      { kind: "profile", name: "work" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('profile "work"');
  });
  it("detects same-origin login routes and hash routes", () => {
    expect(authGuard(target, "https://app.example.test/login", { kind: "state" }).ok).toBe(false);
    expect(
      authGuard(target, "https://app.example.test/#/sign-in?state=secret", { kind: "state" }).ok,
    ).toBe(false);
  });
  it("accepts valid targets, intentional login targets, and no auth", () => {
    expect(authGuard(target, target, { kind: "profile", name: "work" }).ok).toBe(true);
    expect(
      authGuard("https://app.example.test/login", "https://app.example.test/login", {
        kind: "profile",
        name: "work",
      }).ok,
    ).toBe(true);
    expect(authGuard(target, "https://login.example.test/login", { kind: "none" }).ok).toBe(true);
  });
  it("keeps legitimate external redirects and avoids route false positives", () => {
    expect(
      authGuard(target, "https://docs.example.test/login-history", {
        kind: "profile",
        name: "work",
      }).ok,
    ).toBe(true);
    expect(
      authGuard(target, "https://docs.example.test/guide", { kind: "profile", name: "work" }).ok,
    ).toBe(true);
    expect(
      authGuard(target, "https://id.example.test/guide", { kind: "profile", name: "work" }).ok,
    ).toBe(true);
  });
  it("sanitizes storage-state paths in browser errors", () => {
    const result = sanitizeBrowserError(
      new Error("ENOENT /private/storage-state-secret.json"),
      "/private/storage-state-secret.json",
    );
    expect(result.message).toBe("ENOENT <auth-state>");
  });
  it("does not leak OAuth URL data", () => {
    const result = authGuard(
      target,
      "https://login.example.test/login?code=sentinel-code&state=sentinel-state#sentinel-hash",
      { kind: "state" },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain("sentinel");
      expect(result.message).toContain("--auth-state");
    }
  });
});
