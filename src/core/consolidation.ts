import type { Finding } from "./types";

export type ConsolidatedGroup = {
  representative: Finding;
  members: Finding[];
  label: string;
  count: number;
};

export type ConsolidationResult = {
  groups: ConsolidatedGroup[];
  ungrouped: Finding[];
};

/** Extract signature words from a description, stripping URLs, numbers, and common noise. */
export function extractSignatureWords(description: string): Set<string> {
  const cleaned = description
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\b\d+\b/g, "")
    .replace(/[^a-zA-Z\s]/g, " ")
    .toLowerCase();
  const words = cleaned.split(/\s+/).filter((w) => w.length > 2);
  return new Set(words);
}

/** Calculate word overlap ratio between two descriptions. Returns 0-1. */
export function wordOverlap(a: string, b: string): number {
  const wordsA = extractSignatureWords(a);
  const wordsB = extractSignatureWords(b);
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let shared = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) shared++;
  }
  return shared / Math.max(wordsA.size, wordsB.size);
}

/** Find common path prefix from a list of endpoint strings (e.g. "GET /api/data/*"). */
export function findCommonPathPrefix(endpoints: string[]): string {
  if (endpoints.length === 0) return "";
  if (endpoints.length === 1) return endpoints[0]!;

  // Extract just the path portions
  const paths = endpoints.map((ep) => {
    // Strip method prefix like "GET "
    const withoutMethod = ep.replace(/^[A-Z]+\s+/, "");
    try {
      return new URL(withoutMethod).pathname;
    } catch {
      return withoutMethod;
    }
  });

  const segments0 = paths[0]!.split("/");
  let commonLength = 0;

  for (let i = 0; i < segments0.length; i++) {
    const segment = segments0[i];
    if (paths.every((p) => p.split("/")[i] === segment)) {
      commonLength = i + 1;
    } else {
      break;
    }
  }

  const prefix = segments0.slice(0, commonLength).join("/");
  return prefix ? `${prefix}/*` : endpoints[0]!;
}

/**
 * Consolidate findings that share the same severity, category, endpointType
 * and have >60% description word overlap into groups.
 * Groups with <3 members are not consolidated (not worth it).
 */
export function consolidateFindings(findings: Finding[]): ConsolidationResult {
  // Group by (severity, category, endpointType)
  const buckets = new Map<string, Finding[]>();
  for (const f of findings) {
    const key = `${f.severity}|${f.category}|${f.endpointType}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.push(f);
    } else {
      buckets.set(key, [f]);
    }
  }

  const groups: ConsolidatedGroup[] = [];
  const ungrouped: Finding[] = [];

  for (const bucket of buckets.values()) {
    // Within each bucket, cluster by description similarity
    const clusters: Finding[][] = [];

    for (const finding of bucket) {
      let placed = false;
      for (const cluster of clusters) {
        if (wordOverlap(cluster[0]!.description, finding.description) > 0.6) {
          cluster.push(finding);
          placed = true;
          break;
        }
      }
      if (!placed) {
        clusters.push([finding]);
      }
    }

    for (const cluster of clusters) {
      if (cluster.length >= 3) {
        groups.push({
          representative: cluster[0]!,
          members: cluster,
          label: findCommonPathPrefix(cluster.map((f) => f.endpoint)),
          count: cluster.length,
        });
      } else {
        ungrouped.push(...cluster);
      }
    }
  }

  return { groups, ungrouped };
}
