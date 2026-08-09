export type AuthSelection =
  | { kind: "none" }
  | { kind: "profile"; name: string }
  | { kind: "state" };

export type AuthGuardResult = { ok: true } | { ok: false; message: string };

function isLoginRoute(url: URL): boolean {
  const route = `${url.pathname}${url.hash.replace(/^#/, "/")}`;
  return /(?:^|[/])(?:login|signin|sign-in|log-in)(?:[/?#]|$)/i.test(route);
}

function isAuthHost(url: URL): boolean {
  return url.hostname
    .split(".")
    .some((label) => /^(?:auth|login|signin|sso|accounts?|identity|oauth|auth0)$/i.test(label));
}

function isAuthDestination(url: URL): boolean {
  return isAuthHost(url) || isLoginRoute(url) || /\b(?:authorize|sso)\b/i.test(url.pathname);
}

export function authGuard(
  target: string,
  finalUrl: string,
  selection: AuthSelection = { kind: "none" },
): AuthGuardResult {
  if (selection.kind === "none") return { ok: true };
  let targetUrl: URL;
  let currentUrl: URL;
  try {
    targetUrl = new URL(target);
    currentUrl = new URL(finalUrl);
  } catch {
    return { ok: true };
  }
  const targetIsAuthRoute = isLoginRoute(targetUrl);
  const expired =
    (!targetIsAuthRoute && isLoginRoute(currentUrl)) ||
    (currentUrl.origin !== targetUrl.origin && isAuthDestination(currentUrl));
  if (!expired) return { ok: true };
  if (selection.kind === "profile") {
    return {
      ok: false,
      message: `Authentication profile "${selection.name}" appears expired or invalid. Refresh it with: tremor auth setup ${targetUrl.origin} --profile ${selection.name} then retry.`,
    };
  }
  return {
    ok: false,
    message:
      "Authentication state appears expired or invalid; recreate the --auth-state file and retry.",
  };
}
