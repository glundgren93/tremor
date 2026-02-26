import type { RequestMatcher } from "./types";

/**
 * Convert a URL pattern (glob-like) to a RegExp.
 * Supports * as wildcard (matches anything except /) and ** as greedy wildcard.
 */
export function patternToRegex(pattern: string): RegExp {
  if (pattern === "*") return /.*/;

  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§GREEDY§")
    .replace(/\*/g, "[^/]*")
    .replace(/§GREEDY§/g, ".*");

  return new RegExp(`^${escaped}$`);
}

export function matchesRequest(
  matcher: RequestMatcher,
  method: string,
  url: string,
  headers: Record<string, string>,
): boolean {
  if (matcher.method && matcher.method !== method) return false;

  const regex = patternToRegex(matcher.urlPattern);
  const urlWithoutQuery = url.split("?")[0]?.split("#")[0] ?? url;
  if (!regex.test(url) && !regex.test(urlWithoutQuery)) return false;

  if (matcher.headers) {
    for (const [key, value] of Object.entries(matcher.headers)) {
      if (headers[key.toLowerCase()] !== value) return false;
    }
  }

  return true;
}
