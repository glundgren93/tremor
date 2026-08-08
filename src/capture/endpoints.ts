import { getDomain } from "tldts";
import type { CapturedRequest, Endpoint, EndpointType, RequestParty } from "../types/chaos";

const STATIC_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".map",
  ".webp",
  ".avif",
  ".glb",
  ".wasm",
  ".m3u8",
  ".mp4",
  ".webm",
  ".ts",
]);

/** Third-party hostnames — matched against the URL's hostname */
const THIRD_PARTY_HOSTS = [
  // Analytics
  "google-analytics.com",
  "analytics.google.com",
  "googletagmanager.com",
  "gtag",
  "mixpanel.com",
  "amplitude.com",
  "heapanalytics.com",
  "plausible.io",
  "matomo",
  // Error / performance monitoring
  "sentry.io",
  "browser-intake-datadoghq.com",
  "nr-data.net",
  "newrelic.com",
  // Ads & attribution
  "doubleclick.net",
  "googlesyndication.com",
  "facebook.com/tr",
  "connect.facebook.net",
  "ads-twitter.com",
  // Session replay & heatmaps
  "hotjar.com",
  "clarity.ms",
  "fullstory.com",
  "logrocket.com",
  // Customer engagement
  "intercom.io",
  "intercomcdn.com",
  "hubspot.com",
  "hs-scripts.com",
  "hs-analytics.net",
  "crisp.chat",
  "drift.com",
  "zendesk.com",
  // CDP & feature flags
  "segment.io",
  "segment.com",
  "launchdarkly.com",
  "split.io",
  "statsig.com",
  // A/B testing
  "optimizely.com",
  "abtasty.com",
];

/** Same-origin path patterns for common embedded trackers */
const THIRD_PARTY_PATHS = [
  /\/g\/collect/i,
  /\/ahoy\//i,
  /\/beacon\b/i,
  /\/pixel(\.gif|\.png)?(\?|$)/i,
];

function isThirdParty(url: string): boolean {
  try {
    const hostname = new URL(url).hostname;
    if (THIRD_PARTY_HOSTS.some((h) => hostname.includes(h))) return true;
  } catch {
    /* not a valid URL, fall through to path check */
  }
  return THIRD_PARTY_PATHS.some((re) => re.test(url));
}

const ID_PATTERNS = [
  /^\d+$/, // numeric IDs
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // UUID
  /^[0-9a-f]{24}$/i, // MongoDB ObjectId
  /^[0-9a-f]{16,}$/i, // long hex strings
];

function isIdSegment(segment: string): boolean {
  return ID_PATTERNS.some((p) => p.test(segment));
}

function isStaticAsset(url: string): boolean {
  const path = url.split("?")[0] ?? url;
  return STATIC_EXTENSIONS.has(path.slice(path.lastIndexOf(".")));
}

/** Collapse ID-like path segments into `*` to create a URL pattern. */
function collapseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").map((s) => (isIdSegment(s) ? "*" : s));
    return `${parsed.origin}${segments.join("/")}`;
  } catch {
    return url;
  }
}

const API_PATH_PATTERNS = [/\/api\//i, /\/_next\/data\//i, /\/graphql/i, /\/v\d+\//];

/**
 * Classify an endpoint as "document" (HTML page) or "api" (data endpoint).
 * Uses response content-type as primary signal, falls back to URL heuristics.
 */
export function classifyEndpoint(
  pattern: string,
  sampleResponse: { headers: Record<string, string>; body: string } | null,
): EndpointType {
  // Primary signal: response content-type
  if (sampleResponse) {
    const contentType = Object.entries(sampleResponse.headers).find(
      ([k]) => k.toLowerCase() === "content-type",
    )?.[1];
    if (contentType) {
      if (contentType.includes("text/html")) return "document";
      if (
        contentType.includes("application/json") ||
        contentType.includes("application/xml") ||
        contentType.includes("text/xml")
      )
        return "api";
    }
  }

  // Fallback: URL heuristics
  try {
    const url = new URL(pattern);
    const pathname = url.pathname;

    if (API_PATH_PATTERNS.some((p) => p.test(pathname))) return "api";

    // URLs with no file extension and no API pattern → likely document
    const lastSegment = pathname.split("/").pop() ?? "";
    if (!lastSegment.includes(".") && pathname === "/") return "document";
  } catch {
    // Not a valid URL, default to api
  }

  return "api";
}

/**
 * Filter endpoints by path substring (case-insensitive).
 * Extracts pathname from the full URL pattern and checks if it includes the filter string.
 */
export function filterEndpoints(endpoints: Endpoint[], filter: string): Endpoint[] {
  const lower = filter.toLowerCase();
  return endpoints.filter((ep) => {
    try {
      const pathname = new URL(ep.pattern).pathname;
      return pathname.toLowerCase().includes(lower);
    } catch {
      return ep.pattern.toLowerCase().includes(lower);
    }
  });
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  const wanted = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === wanted)?.[1];
}

/** Cross-origin authorization comes only from Chromium's Fetch Metadata. */
export function requestParty(request: CapturedRequest, targetUrl?: string): RequestParty {
  if (!targetUrl) return "same-origin";
  try {
    if (new URL(request.url).origin === new URL(targetUrl).origin) return "same-origin";
  } catch {
    return "unknown";
  }
  const attested = headerValue(request.headers, "sec-fetch-site")?.toLowerCase();
  if (attested === "cross-site") return "cross-site";
  if (attested !== "same-site") return "unknown";

  // Fetch Metadata is relative to the immediate initiator. A third-party
  // iframe can truthfully emit "same-site" for its own API, so also require
  // the request and top-level page to share a PSL-backed site.
  const requestDomain = registrableDomain(request.url);
  const targetDomain = registrableDomain(targetUrl);
  return requestDomain && requestDomain === targetDomain ? "same-site" : "cross-site";
}

export function isSpeculativeRequest(request: CapturedRequest): boolean {
  const purpose =
    headerValue(request.headers, "purpose") ?? headerValue(request.headers, "sec-purpose");
  return (
    purpose?.toLowerCase().includes("prefetch") === true ||
    headerValue(request.headers, "next-router-prefetch") === "1"
  );
}

/**
 * Deduplicate captured requests into unique API endpoints.
 * Collapses ID-like path segments, groups by method + collapsed path,
 * and keeps the most recent sample response.
 */
export function deduplicateEndpoints(requests: CapturedRequest[], targetUrl?: string): Endpoint[] {
  const grouped = new Map<string, { requests: CapturedRequest[]; pattern: string }>();

  for (const req of requests) {
    if (isStaticAsset(req.url)) continue;
    if (isThirdParty(req.url)) continue;

    const pattern = collapseUrl(req.url);
    const key = `${req.method}:${pattern}`;

    const group = grouped.get(key);
    if (group) {
      group.requests.push(req);
    } else {
      grouped.set(key, { requests: [req], pattern });
    }
  }

  const endpoints: Endpoint[] = [];

  for (const [, { requests: reqs, pattern }] of grouped) {
    const latest = reqs.reduce((a, b) => (a.timestamp > b.timestamp ? a : b));

    const sampleResponse = latest.response
      ? {
          status: latest.response.status,
          headers: latest.response.headers,
          body: latest.response.body,
        }
      : null;

    const parties = reqs.map((request) => requestParty(request, targetUrl));
    const party: RequestParty = parties.includes("same-origin")
      ? "same-origin"
      : parties.includes("same-site")
        ? "same-site"
        : parties.every((value) => value === "cross-site")
          ? "cross-site"
          : "unknown";
    endpoints.push({
      method: latest.method,
      pattern,
      resourceTypes: [
        ...new Set(reqs.map((request) => request.resourceType).filter(Boolean)),
      ] as string[],
      sampleUrl: latest.url,
      sampleResponse,
      hitCount: reqs.length,
      endpointType: classifyEndpoint(pattern, sampleResponse),
      party,
      firstParty: party === "same-origin" || party === "same-site",
      speculative: reqs.every(isSpeculativeRequest),
      replayed: false,
    });
  }

  return endpoints;
}

/** PSL-backed site identity, including private hosting suffixes. */
export function registrableDomain(url: string): string | null {
  try {
    const { hostname } = new URL(url);
    return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
  } catch {
    return null;
  }
}
