export interface RedactionConfig {
  headerPatterns: string[];
  urlPatterns: string[];
}

export const DEFAULT_REDACTION_CONFIG: RedactionConfig = {
  headerPatterns: ["authorization", "cookie", "set-cookie", "x-api-key", "x-auth-token"],
  urlPatterns: [".tremor/chromium-profile"],
};

export function redactUrl(url: string, config: RedactionConfig): string {
  if (config.urlPatterns.length === 0) return url;
  let result = url;
  for (const pattern of config.urlPatterns) {
    if (result.toLowerCase().includes(pattern.toLowerCase())) {
      result = result.replaceAll(new RegExp(escapeRegex(pattern), "gi"), "[REDACTED]");
    }
  }
  return result;
}

export function redactHeaders(
  headers: Record<string, string>,
  config: RedactionConfig,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    const keyLower = key.toLowerCase();
    const matches = config.headerPatterns.some((p) => keyLower.includes(p.toLowerCase()));
    result[key] = matches ? "[REDACTED]" : value;
  }
  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
