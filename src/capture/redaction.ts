export interface RedactionConfig {
  headerPatterns: string[];
  urlPatterns: string[];
}

export const DEFAULT_REDACTION_CONFIG: RedactionConfig = {
  headerPatterns: [
    "authorization",
    "cookie",
    "set-cookie",
    "x-api-key",
    "x-auth-token",
    "token",
    "secret",
    "password",
    "state",
    "nonce",
    "code_verifier",
    "code_challenge",
    "api-key",
    "apikey",
  ],
  urlPatterns: [".tremor/chromium-profile"],
};

const SECRET_KEY =
  /(?:^|[_-])(token|access[_-]?token|refresh[_-]?token|auth(?:orization)?|api[_-]?key|key|secret|client[_-]?secret|password|code|state|nonce|code[_-]?(?:verifier|challenge)|session(?:[_-]?id)?)(?:$|[_-])/i;
const BODY_LIMIT = 256 * 1024;

function secretKey(key: string): boolean {
  return (
    SECRET_KEY.test(key) ||
    /^(token|accessToken|refreshToken|auth|key|secret|clientSecret|password|code|state|nonce|code_verifier|code_challenge|session|sessionId)$/i.test(
      key,
    )
  );
}

function redactValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, secretKey(k) ? "[REDACTED]" : redactValue(v)]),
    );
  }
  return value;
}

/** Redact JSON, urlencoded, or safely parseable bodies; never retain opaque data. */
export function redactBody(body: string | null | undefined, contentType = ""): string | null {
  if (!body) return null;
  try {
    if (contentType.toLowerCase().includes("json") || /^\s*[[{]/.test(body)) {
      return JSON.stringify(redactValue(JSON.parse(body))).slice(0, BODY_LIMIT);
    }
    if (contentType.toLowerCase().includes("form-urlencoded") || body.includes("=")) {
      const params = new URLSearchParams(body);
      if ([...params.keys()].length > 0) {
        for (const key of params.keys()) if (secretKey(key)) params.set(key, "[REDACTED]");
        return params.toString().slice(0, BODY_LIMIT);
      }
    }
  } catch {
    /* opaque bodies are intentionally omitted */
  }
  return null;
}

function redactFragment(parsed: URL): void {
  const fragment = parsed.hash.slice(1);
  if (!fragment) return;
  const queryIndex = fragment.indexOf("?");
  const params = queryIndex >= 0 ? new URLSearchParams(fragment.slice(queryIndex + 1)) : null;
  if (params && [...params.keys()].some(secretKey)) {
    for (const key of params.keys()) if (secretKey(key)) params.set(key, "[REDACTED]");
    parsed.hash = `#${fragment.slice(0, queryIndex + 1)}${params.toString()}`;
  } else if (!fragment.startsWith("/")) parsed.hash = "#[REDACTED]";
}
function redactParsedUrl(parsed: URL): string {
  if (parsed.username || parsed.password) {
    parsed.username = "[REDACTED]";
    parsed.password = "[REDACTED]";
  }
  for (const key of [...parsed.searchParams.keys()])
    if (secretKey(key)) parsed.searchParams.set(key, "[REDACTED]");
  redactFragment(parsed);
  return parsed.toString();
}
export function redactUrl(url: string, config: RedactionConfig): string {
  let result = url;
  try {
    result = redactParsedUrl(new URL(url));
  } catch {
    /* malformed URLs remain available for pattern redaction */
  }
  for (const pattern of config.urlPatterns)
    if (result.toLowerCase().includes(pattern.toLowerCase()))
      result = result.replaceAll(new RegExp(escapeRegex(pattern), "gi"), "[REDACTED]");
  return result;
}

export function redactResponseBody(
  body: string | null | undefined,
  contentType = "",
): string | null {
  return redactBody(body, contentType);
}

/** Redact every HTTP(S) URL embedded in diagnostic text before it reaches stdout. */
export function redactUrlsInText(
  text: string,
  config: RedactionConfig = DEFAULT_REDACTION_CONFIG,
): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url, config));
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
