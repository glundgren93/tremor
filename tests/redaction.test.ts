import { describe, expect, it } from "vitest";
import {
  DEFAULT_REDACTION_CONFIG,
  type RedactionConfig,
  redactHeaders,
  redactUrl,
} from "../src/core/redaction";

describe("redactUrl", () => {
  it("returns url unchanged when no url patterns match", () => {
    expect(redactUrl("https://api.example.com/users", DEFAULT_REDACTION_CONFIG)).toBe(
      "https://api.example.com/users",
    );
  });

  it("redacts matching substring in url", () => {
    const config: RedactionConfig = {
      headerPatterns: [],
      urlPatterns: ["secret-token"],
    };
    expect(redactUrl("https://api.example.com/secret-token/data", config)).toBe(
      "https://api.example.com/[REDACTED]/data",
    );
  });

  it("redacts multiple occurrences", () => {
    const config: RedactionConfig = {
      headerPatterns: [],
      urlPatterns: ["abc"],
    };
    expect(redactUrl("https://abc.example.com/abc/path", config)).toBe(
      "https://[REDACTED].example.com/[REDACTED]/path",
    );
  });

  it("is case-insensitive", () => {
    const config: RedactionConfig = {
      headerPatterns: [],
      urlPatterns: ["SECRET"],
    };
    expect(redactUrl("https://api.example.com/secret/data", config)).toBe(
      "https://api.example.com/[REDACTED]/data",
    );
  });

  it("handles multiple url patterns", () => {
    const config: RedactionConfig = {
      headerPatterns: [],
      urlPatterns: ["token", "key"],
    };
    expect(redactUrl("https://api.example.com/token?key=123", config)).toBe(
      "https://api.example.com/[REDACTED]?[REDACTED]=123",
    );
  });

  it("returns url unchanged when no patterns match", () => {
    const config: RedactionConfig = {
      headerPatterns: [],
      urlPatterns: ["no-match"],
    };
    expect(redactUrl("https://api.example.com/users", config)).toBe(
      "https://api.example.com/users",
    );
  });
});

describe("redactHeaders", () => {
  it("redacts default auth headers", () => {
    const headers = {
      authorization: "Bearer abc123",
      "content-type": "application/json",
      cookie: "session=xyz",
    };
    const result = redactHeaders(headers, DEFAULT_REDACTION_CONFIG);
    expect(result.authorization).toBe("[REDACTED]");
    expect(result["content-type"]).toBe("application/json");
    expect(result.cookie).toBe("[REDACTED]");
  });

  it("is case-insensitive on header names", () => {
    const headers = {
      Authorization: "Bearer abc123",
      "X-API-KEY": "secret",
    };
    const result = redactHeaders(headers, DEFAULT_REDACTION_CONFIG);
    expect(result.Authorization).toBe("[REDACTED]");
    expect(result["X-API-KEY"]).toBe("[REDACTED]");
  });

  it("uses substring matching on header patterns", () => {
    const config: RedactionConfig = {
      headerPatterns: ["auth"],
      urlPatterns: [],
    };
    const headers = {
      authorization: "Bearer abc",
      "x-auth-token": "tok",
      "content-type": "text/plain",
    };
    const result = redactHeaders(headers, config);
    expect(result.authorization).toBe("[REDACTED]");
    expect(result["x-auth-token"]).toBe("[REDACTED]");
    expect(result["content-type"]).toBe("text/plain");
  });

  it("preserves all headers when no patterns match", () => {
    const config: RedactionConfig = {
      headerPatterns: ["no-match"],
      urlPatterns: [],
    };
    const headers = { "content-type": "application/json", accept: "*/*" };
    const result = redactHeaders(headers, config);
    expect(result).toEqual(headers);
  });

  it("handles empty headers", () => {
    const result = redactHeaders({}, DEFAULT_REDACTION_CONFIG);
    expect(result).toEqual({});
  });
});

describe("DEFAULT_REDACTION_CONFIG", () => {
  it("has expected default header patterns", () => {
    expect(DEFAULT_REDACTION_CONFIG.headerPatterns).toContain("authorization");
    expect(DEFAULT_REDACTION_CONFIG.headerPatterns).toContain("cookie");
    expect(DEFAULT_REDACTION_CONFIG.headerPatterns).toContain("set-cookie");
    expect(DEFAULT_REDACTION_CONFIG.headerPatterns).toContain("x-api-key");
    expect(DEFAULT_REDACTION_CONFIG.headerPatterns).toContain("x-auth-token");
  });

  it("has default url pattern for chromium profile", () => {
    expect(DEFAULT_REDACTION_CONFIG.urlPatterns).toContain(".tremor/chromium-profile");
  });
});
