import { MAX_ROUTES, validateRoutePath } from "./routes";

export type DiscoveryExclusions = {
  crossOrigin: number;
  unsafeScheme: number;
  credentials: number;
  queryOrFragment: number;
  invalidRoute: number;
  current: number;
  nonRendered: number;
  downloadOrAsset: number;
  actionLike: number;
};
export type DiscoveredCandidate = { path: string; occurrences: number };
export type DiscoverOutput = {
  candidates: DiscoveredCandidate[];
  eligibleTotal: number;
  returned: number;
  truncated: boolean;
  routeTestLimit: number;
  excluded: DiscoveryExclusions;
};

const ACTION = /(?:^|\/)(?:logout|signout|delete|remove|revoke|disconnect)(?:\/|$)/i;
const ASSET =
  /\.(?:7z|avi|bin|css|csv|docx?|exe|gif|gz|ico|jpe?g|js|m4a|mp[34]|pdf|png|rar|svg|tar|txt|webm|webp|xlsx?|xml|zip)$/i;
const MAX_LIMIT = 100;

export function normalizeDiscoverLimit(value: number | undefined): number {
  if (value === undefined) return 20;
  if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT)
    throw new Error(`--limit must be an integer from 1 to ${MAX_LIMIT}`);
  return value;
}

function rawPathname(href: string): string {
  const withoutQueryOrFragment = href.split(/[?#]/u, 1)[0] ?? "";
  const absolute = /^[a-z][a-z\d+.-]*:\/\/[^/]*(\/.*)?$/iu.exec(withoutQueryOrFragment);
  if (absolute) return absolute[1] ?? "/";
  const protocolRelative = /^\/\/[^/]*(\/.*)?$/u.exec(withoutQueryOrFragment);
  return protocolRelative ? (protocolRelative[1] ?? "/") : withoutQueryOrFragment;
}

function hasUnsafeRawPath(path: string): boolean {
  return (
    path.includes("%") ||
    path.includes("\\") ||
    [...path].some(
      (character) =>
        /\s/u.test(character) ||
        (character.codePointAt(0) ?? 0) < 32 ||
        character.codePointAt(0) === 127,
    ) ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: bounded URL policy is intentionally explicit
export function collectCandidates(
  links: { href: string; rawHref: string; rendered: boolean; downloadable?: boolean }[],
  target: { origin: string; pathname: string },
  limit: number,
): DiscoverOutput {
  const excluded: DiscoveryExclusions = {
    crossOrigin: 0,
    unsafeScheme: 0,
    credentials: 0,
    queryOrFragment: 0,
    invalidRoute: 0,
    current: 0,
    nonRendered: 0,
    downloadOrAsset: 0,
    actionLike: 0,
  };
  const candidates: DiscoveredCandidate[] = [];
  const byPath = new Map<string, DiscoveredCandidate>();
  for (const link of links) {
    if (!link.rendered) {
      excluded.nonRendered++;
      continue;
    }
    if (link.downloadable) {
      excluded.downloadOrAsset++;
      continue;
    }
    const rawPath = rawPathname(link.rawHref);
    if (hasUnsafeRawPath(rawPath)) {
      excluded.invalidRoute++;
      continue;
    }
    let url: URL;
    try {
      url = new URL(link.href, `${target.origin}${target.pathname}`);
    } catch {
      excluded.unsafeScheme++;
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      excluded.unsafeScheme++;
      continue;
    }
    if (url.origin !== target.origin) {
      excluded.crossOrigin++;
      continue;
    }
    if (url.username || url.password) {
      excluded.credentials++;
      continue;
    }
    if (url.search || url.hash) {
      excluded.queryOrFragment++;
      continue;
    }
    const path = url.pathname;
    if (path === target.pathname) {
      excluded.current++;
      continue;
    }
    if (ASSET.test(path) || (url.pathname.endsWith("/") && ASSET.test(url.pathname.slice(0, -1)))) {
      excluded.downloadOrAsset++;
      continue;
    }
    if (ACTION.test(path)) {
      excluded.actionLike++;
      continue;
    }
    try {
      validateRoutePath(path);
    } catch {
      excluded.invalidRoute++;
      continue;
    }
    const existing = byPath.get(path);
    if (existing) existing.occurrences++;
    else {
      const candidate = { path, occurrences: 1 };
      byPath.set(path, candidate);
      candidates.push(candidate);
    }
  }
  return {
    candidates: candidates.slice(0, limit),
    eligibleTotal: candidates.length,
    returned: Math.min(limit, candidates.length),
    truncated: candidates.length > limit,
    routeTestLimit: MAX_ROUTES,
    excluded,
  };
}

export const DISCOVER_LIMIT_MAX = MAX_LIMIT;
