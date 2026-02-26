import type { CapturedRequest, Endpoint, EndpointType } from "./types";

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
  } catch { /* not a valid URL, fall through to path check */ }
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

/**
 * Deduplicate captured requests into unique API endpoints.
 * Collapses ID-like path segments, groups by method + collapsed path,
 * and keeps the most recent sample response.
 */
export function deduplicateEndpoints(requests: CapturedRequest[]): Endpoint[] {
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

    endpoints.push({
      method: latest.method,
      pattern,
      sampleUrl: latest.url,
      sampleResponse,
      hitCount: reqs.length,
      endpointType: classifyEndpoint(pattern, sampleResponse),
    });
  }

  return endpoints;
}
