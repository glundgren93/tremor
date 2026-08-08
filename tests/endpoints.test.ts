import { describe, expect, it } from "vitest";
import { classifyEndpoint, deduplicateEndpoints } from "../src/capture/endpoints";
import type { CapturedRequest } from "../src/types/chaos";

function makeRequest(overrides: Partial<CapturedRequest>): CapturedRequest {
  return {
    id: "test-1",
    timestamp: Date.now(),
    method: "GET",
    url: "https://api.example.com/users",
    headers: {},
    body: null,
    response: {
      status: 200,
      statusText: "OK",
      headers: { "content-type": "application/json" },
      body: "{}",
      duration: 100,
    },
    ...overrides,
  };
}

describe("deduplicateEndpoints", () => {
  it("collapses numeric IDs into *", () => {
    const requests = [
      makeRequest({ url: "https://api.example.com/users/123" }),
      makeRequest({ url: "https://api.example.com/users/456" }),
    ];
    const endpoints = deduplicateEndpoints(requests);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.pattern).toBe("https://api.example.com/users/*");
    expect(endpoints[0]?.hitCount).toBe(2);
  });

  it("collapses UUIDs into *", () => {
    const requests = [
      makeRequest({ url: "https://api.example.com/items/550e8400-e29b-41d4-a716-446655440000" }),
      makeRequest({ url: "https://api.example.com/items/6ba7b810-9dad-11d1-80b4-00c04fd430c8" }),
    ];
    const endpoints = deduplicateEndpoints(requests);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.pattern).toBe("https://api.example.com/items/*");
  });

  it("filters out static assets", () => {
    const requests = [
      makeRequest({ url: "https://example.com/bundle.js" }),
      makeRequest({ url: "https://example.com/style.css" }),
      makeRequest({ url: "https://example.com/logo.png" }),
      makeRequest({ url: "https://example.com/model.glb", resourceType: "fetch" }),
      makeRequest({ url: "https://example.com/worker.wasm", resourceType: "fetch" }),
      makeRequest({ url: "https://api.example.com/data" }),
    ];
    const endpoints = deduplicateEndpoints(requests);
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0]?.pattern).toContain("/data");
  });

  it("separates different methods", () => {
    const requests = [
      makeRequest({ method: "GET", url: "https://api.example.com/users" }),
      makeRequest({ method: "POST", url: "https://api.example.com/users" }),
    ];
    const endpoints = deduplicateEndpoints(requests);
    expect(endpoints).toHaveLength(2);
  });

  it("preserves every observed browser resource type", () => {
    const requests = [
      makeRequest({ resourceType: "xhr", url: "https://api.example.com/users" }),
      makeRequest({ resourceType: "fetch", url: "https://api.example.com/users" }),
      makeRequest({ resourceType: "xhr", url: "https://api.example.com/users" }),
    ];
    const endpoints = deduplicateEndpoints(requests);
    expect(endpoints[0]?.resourceTypes).toEqual(["xhr", "fetch"]);
  });

  it("keeps most recent sample response", () => {
    const requests = [
      makeRequest({
        id: "old",
        timestamp: 1000,
        url: "https://api.example.com/users",
        response: {
          status: 200,
          statusText: "OK",
          headers: {},
          body: '{"old": true}',
          duration: 50,
        },
      }),
      makeRequest({
        id: "new",
        timestamp: 2000,
        url: "https://api.example.com/users",
        response: {
          status: 200,
          statusText: "OK",
          headers: {},
          body: '{"new": true}',
          duration: 50,
        },
      }),
    ];
    const endpoints = deduplicateEndpoints(requests);
    expect(endpoints[0]?.sampleResponse?.body).toBe('{"new": true}');
  });

  it("marks framework prefetch-only endpoints as speculative", () => {
    const [endpoint] = deduplicateEndpoints([
      makeRequest({
        url: "https://example.com/pricing",
        resourceType: "fetch",
        headers: { "next-router-prefetch": "1" },
      }),
    ]);
    expect(endpoint?.speculative).toBe(true);
  });

  it("returns empty array for no requests", () => {
    expect(deduplicateEndpoints([])).toEqual([]);
  });

  it("classifies endpoints with endpointType", () => {
    const requests = [
      makeRequest({
        url: "https://example.com/api/users",
        response: {
          status: 200,
          statusText: "OK",
          headers: { "content-type": "application/json" },
          body: '{"id": 1}',
          duration: 100,
        },
      }),
    ];
    const endpoints = deduplicateEndpoints(requests);
    expect(endpoints[0]?.endpointType).toBe("api");
  });
});

describe("classifyEndpoint", () => {
  it("classifies HTML response as document", () => {
    const result = classifyEndpoint("https://example.com/", {
      headers: { "content-type": "text/html; charset=utf-8" },
      body: "<html><body>Hello</body></html>",
    });
    expect(result).toBe("document");
  });

  it("classifies JSON response as api", () => {
    const result = classifyEndpoint("https://example.com/api/users", {
      headers: { "content-type": "application/json" },
      body: '{"users": []}',
    });
    expect(result).toBe("api");
  });

  it("classifies /api/ URL as api even without response", () => {
    const result = classifyEndpoint("https://example.com/api/users", null);
    expect(result).toBe("api");
  });

  it("classifies /_next/data/ URL as api", () => {
    const result = classifyEndpoint("https://example.com/_next/data/abc123/index.json", null);
    expect(result).toBe("api");
  });

  it("classifies root URL with HTML content as document", () => {
    const result = classifyEndpoint("https://example.com/", {
      headers: { "content-type": "text/html" },
      body: "<html></html>",
    });
    expect(result).toBe("document");
  });

  it("classifies root URL without response as document", () => {
    const result = classifyEndpoint("https://example.com/", null);
    expect(result).toBe("document");
  });

  it("defaults to api for unknown patterns", () => {
    const result = classifyEndpoint("https://example.com/some/path", null);
    expect(result).toBe("api");
  });

  it("classifies /graphql URL as api", () => {
    const result = classifyEndpoint("https://example.com/graphql", null);
    expect(result).toBe("api");
  });

  it("classifies versioned API URL as api", () => {
    const result = classifyEndpoint("https://example.com/v2/users", null);
    expect(result).toBe("api");
  });
});

describe("first-party classification", () => {
  const req = (url: string, fetchSite?: string): CapturedRequest => ({
    id: url,
    timestamp: 1,
    method: "GET",
    url,
    headers: fetchSite ? { "sec-fetch-site": fetchSite } : {},
    body: null,
    response: { status: 200, statusText: "OK", headers: {}, body: "{}", duration: 1 },
  });

  it("accepts the exact origin without Fetch Metadata", () => {
    const [e] = deduplicateEndpoints([req("https://app.test/api/news")], "https://app.test/");
    expect(e).toMatchObject({ party: "same-origin", firstParty: true });
  });

  it("accepts browser-attested same-site subdomains", () => {
    const [e] = deduplicateEndpoints(
      [req("https://api.globo.com/v1/news", "same-site")],
      "https://www.globo.com/",
    );
    expect(e).toMatchObject({ party: "same-site", firstParty: true });
  });

  it("rejects initiator-relative same-site metadata from a third-party iframe", () => {
    const [e] = deduplicateEndpoints(
      [req("https://ut.pubmatic.com/geo", "same-site")],
      "https://www.globo.com/",
    );
    expect(e).toMatchObject({ party: "cross-site", firstParty: false });
  });

  it("rejects same-site metadata between sibling private-hosting tenants", () => {
    const [e] = deduplicateEndpoints(
      [req("https://tenant-b.up.railway.app/api", "same-site")],
      "https://tenant-a.up.railway.app/",
    );
    expect(e).toMatchObject({ party: "cross-site", firstParty: false });
  });

  it("fails closed for cross-origin requests without Fetch Metadata", () => {
    const [e] = deduplicateEndpoints(
      [req("https://api.globo.com/v1/news")],
      "https://www.globo.com/",
    );
    expect(e).toMatchObject({ party: "unknown", firstParty: false });
  });

  it("defaults to first-party when no target url is supplied", () => {
    const [e] = deduplicateEndpoints([req("https://anything.test/x")]);
    expect(e).toMatchObject({ party: "same-origin", firstParty: true });
  });
});
