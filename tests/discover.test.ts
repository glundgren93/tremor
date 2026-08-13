import { describe, expect, it } from "vitest";
import { collectCandidates, normalizeDiscoverLimit } from "../src/cli/discover";

describe("discover", () => {
  it("collects rendered same-origin routes in DOM order", () => {
    const result = collectCandidates(
      [
        { href: "https://app.test/reports#top", rawHref: "/reports#top", rendered: true },
        { href: "https://app.test/reports", rawHref: "/reports", rendered: true },
        { href: "https://other.test/x", rawHref: "https://other.test/x", rendered: true },
        { href: "https://app.test/hidden", rawHref: "/hidden", rendered: false },
      ],
      { origin: "https://app.test", pathname: "/home" },
      20,
    );
    expect(result.candidates).toEqual([{ path: "/reports", occurrences: 1 }]);
    expect(result.excluded.queryOrFragment).toBe(1);
    expect(result.excluded.crossOrigin).toBe(1);
    expect(result.excluded.nonRendered).toBe(1);
  });
  it("caps output while retaining eligible total", () => {
    const links = Array.from({ length: 3 }, (_, i) => ({
      href: `https://app.test/r${i}`,
      rawHref: `/r${i}`,
      rendered: true,
    }));
    const result = collectCandidates(links, { origin: "https://app.test", pathname: "/" }, 2);
    expect(result.eligibleTotal).toBe(3);
    expect(result.returned).toBe(2);
    expect(result.truncated).toBe(true);
  });
  it("rejects downloads and raw paths that would be normalized into valid routes", () => {
    const result = collectCandidates(
      [
        {
          href: "https://app.test/export",
          rawHref: "/export",
          rendered: true,
          downloadable: true,
        },
        { href: "https://app.test/reports", rawHref: "/a/../reports", rendered: true },
        { href: "https://app.test/reports", rawHref: "/%2e%2e/reports", rendered: true },
        { href: "https://app.test/reports", rawHref: "/a\\reports", rendered: true },
      ],
      { origin: "https://app.test", pathname: "/home" },
      20,
    );
    expect(result.candidates).toEqual([]);
    expect(result.excluded.downloadOrAsset).toBe(1);
    expect(result.excluded.invalidRoute).toBe(3);
  });
  it("validates limits", () => {
    expect(normalizeDiscoverLimit(undefined)).toBe(20);
    expect(() => normalizeDiscoverLimit(101)).toThrow();
  });
});
