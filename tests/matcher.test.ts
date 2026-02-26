import { describe, expect, it } from "vitest";
import { matchesRequest, patternToRegex } from "../src/core/matcher";

describe("patternToRegex", () => {
  it("matches everything with *", () => {
    expect(patternToRegex("*").test("https://example.com/api/users")).toBe(true);
  });

  it("matches single segment with *", () => {
    const regex = patternToRegex("https://example.com/api/*/details");
    expect(regex.test("https://example.com/api/123/details")).toBe(true);
    expect(regex.test("https://example.com/api/123/456/details")).toBe(false);
  });

  it("matches greedy with **", () => {
    const regex = patternToRegex("https://example.com/**");
    expect(regex.test("https://example.com/api/users/123")).toBe(true);
    expect(regex.test("https://example.com/")).toBe(true);
  });

  it("escapes special regex chars", () => {
    const regex = patternToRegex("https://example.com/api/v1.0/users");
    expect(regex.test("https://example.com/api/v1.0/users")).toBe(true);
    expect(regex.test("https://example.com/api/v1X0/users")).toBe(false);
  });
});

describe("matchesRequest", () => {
  it("matches by URL pattern", () => {
    expect(
      matchesRequest(
        { urlPattern: "https://api.example.com/**" },
        "GET",
        "https://api.example.com/users",
        {},
      ),
    ).toBe(true);
  });

  it("filters by method", () => {
    expect(
      matchesRequest({ urlPattern: "**", method: "POST" }, "GET", "https://example.com/api", {}),
    ).toBe(false);
  });

  it("matches method and URL", () => {
    expect(
      matchesRequest(
        { urlPattern: "https://api.example.com/**", method: "POST" },
        "POST",
        "https://api.example.com/users",
        {},
      ),
    ).toBe(true);
  });

  it("strips query params for matching", () => {
    expect(
      matchesRequest(
        { urlPattern: "https://api.example.com/users" },
        "GET",
        "https://api.example.com/users?page=1",
        {},
      ),
    ).toBe(true);
  });

  it("matches with headers", () => {
    expect(
      matchesRequest(
        { urlPattern: "**", headers: { "content-type": "application/json" } },
        "GET",
        "https://example.com",
        { "content-type": "application/json" },
      ),
    ).toBe(true);
  });

  it("rejects on header mismatch", () => {
    expect(
      matchesRequest(
        { urlPattern: "**", headers: { "content-type": "application/json" } },
        "GET",
        "https://example.com",
        { "content-type": "text/html" },
      ),
    ).toBe(false);
  });
});
