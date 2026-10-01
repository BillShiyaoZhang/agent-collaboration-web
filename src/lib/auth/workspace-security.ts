import type { NextAuthOptions } from "next-auth";

export type WorkspaceOriginMode = "separate-site" | "same-site-subdomains";

// This module also runs in Edge middleware. Keep it free of Node/server imports.
export function workspaceOriginMode(): WorkspaceOriginMode {
  const value = process.env.WORKSPACE_GATEWAY_ORIGIN_MODE ?? "separate-site";
  if (value !== "separate-site" && value !== "same-site-subdomains")
    throw new Error("Invalid workspace origin mode");
  return value;
}

export function workspacePortalPolicy() {
  const mode = workspaceOriginMode();
  if (mode === "separate-site") return { mode, origin: null };
  const portal = new URL(process.env.NEXTAUTH_URL || "");
  if (portal.protocol !== "https:" || portal.username || portal.password || portal.pathname !== "/"
      || portal.search || portal.hash)
    throw new Error("Same-site workspaces require a canonical HTTPS portal origin");
  return { mode, origin: portal.origin };
}

export function workspaceNextAuthCookies(): Pick<NextAuthOptions, "cookies" | "useSecureCookies"> {
  if (workspacePortalPolicy().mode === "separate-site") return {};
  const options = { secure: true, httpOnly: true, sameSite: "lax" as const, path: "/" };
  return {
    useSecureCookies: true,
    cookies: {
      sessionToken: { name: "__Host-next-auth.session-token", options: { ...options } },
      callbackUrl: { name: "__Host-next-auth.callback-url", options: { ...options } },
      csrfToken: { name: "__Host-next-auth.csrf-token", options: { ...options } },
      pkceCodeVerifier: { name: "__Host-next-auth.pkce.code_verifier", options: { ...options, maxAge: 900 } },
      state: { name: "__Host-next-auth.state", options: { ...options, maxAge: 900 } },
      nonce: { name: "__Host-next-auth.nonce", options: { ...options } },
    },
  };
}

export function workspaceSessionCookieName(): string {
  if (workspacePortalPolicy().mode === "same-site-subdomains") return "__Host-next-auth.session-token";
  // Match NextAuth's existing getToken defaults, including the Vercel fallback.
  const secure = process.env.NEXTAUTH_URL?.startsWith("https://") ?? !!process.env.VERCEL;
  return secure ? "__Secure-next-auth.session-token" : "next-auth.session-token";
}

export function portalBrowserRequestAllowed(request: Request, policy = workspacePortalPolicy()): boolean {
  if (policy.mode === "separate-site") return true;
  const site = request.headers.get("sec-fetch-site"), origin = request.headers.get("origin");
  const cookie = !!request.headers.get("cookie"), safe = ["GET", "HEAD"].includes(request.method);
  // Sibling workspace origins are untrusted, even though SameSite sends cookies.
  if (site === "same-site" || (origin !== null && origin !== policy.origin)) return false;
  if (cookie && !["same-origin", "cross-site", "none"].includes(site || "")) return false;
  if (cookie && !safe && origin !== policy.origin) return false;
  if (site === "cross-site") {
    // A page may be opened from an external link. An API GET may poll/project
    // state, so cross-origin document navigation must not bypass its perimeter.
    const path = new URL(request.url).pathname;
    return safe && request.headers.get("sec-fetch-mode") === "navigate"
      && request.headers.get("sec-fetch-dest") === "document" && path !== "/api" && !path.startsWith("/api/");
  }
  if (site === "none" && !safe) return false;
  // Cookie-free CLI onboarding retains its existing signature/Bearer checks.
  return true;
}

export function portalIsolationHeaders(policy = workspacePortalPolicy()): Record<string, string> {
  return policy.mode === "same-site-subdomains"
    ? { "Origin-Agent-Cluster": "?1", "Cross-Origin-Opener-Policy": "same-origin" } : {};
}
