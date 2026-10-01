import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getToken } from "next-auth/jwt";
import { portalBrowserRequestAllowed, portalIsolationHeaders, workspacePortalPolicy, workspaceSessionCookieName } from "./lib/auth/workspace-security";

// List of public routes that don't require authentication
const publicRoutes = ["/", "/docs", "/docs/", "/privacy", "/privacy/", "/community", "/community/", "/login", "/register", "/forgot-password", "/resend-verification", "/verify-email", "/reset-password", "/confirm-password-change", "/api/auth"];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  let policy: ReturnType<typeof workspacePortalPolicy>;
  try { policy = workspacePortalPolicy(); }
  catch {
    return NextResponse.json({ error: "Portal security configuration is invalid" }, {
      status: 503, headers: { "Cache-Control": "private, no-store" },
    });
  }
  const finish = (response: NextResponse) => {
    for (const [name, value] of Object.entries(portalIsolationHeaders(policy))) response.headers.set(name, value);
    return response;
  };
  // Apply before public/auth/onboarding routes: a sibling cannot plant sessions
  // or reach read endpoints merely because it shares the registrable domain.
  if (!portalBrowserRequestAllowed(request, policy))
    return finish(NextResponse.json({ error: "Forbidden browser source" }, {
      status: 403, headers: { "Cache-Control": "private, no-store" },
    }));

  // Check if the route is public
  const isPublicRoute = publicRoutes.some((route) => pathname === route || (route === "/api/auth" && pathname.startsWith(route + "/")))
    || pathname.startsWith("/docs/source/")
    || pathname === "/api/onboarding" || /^\/api\/onboarding\/[0-9a-f-]{36}$/.test(pathname)
    || pathname === "/agent-install.md" || pathname === "/llms.txt";

  const isPublicArtwork = pathname === "/brand/agent-loop-sage.png"
    || pathname === "/brand/agent-loop-lilac.png";
  if (isPublicRoute || isPublicArtwork || pathname === "/beian-icon.png" || pathname === "/agent-comm-sw.js") {
    return finish(NextResponse.next());
  }

  // Validate the session, including NextAuth's HTTPS and chunked cookies.
  const token = await getToken({
    req: request,
    secret: process.env.NEXTAUTH_SECRET,
    cookieName: workspaceSessionCookieName(),
  });

  if (!token || token.sessionRevoked === true) {
    if (pathname.startsWith("/api/")) {
      return finish(NextResponse.json({ error: "Unauthorized" }, {
        status: 401,
        headers: { "Cache-Control": "private, no-store" },
      }));
    }
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname === "/connect-workspace" ? pathname + request.nextUrl.search : pathname);
    return finish(NextResponse.redirect(loginUrl));
  }

  return finish(NextResponse.next());
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - favicon.ico (favicon file)
     * - public folder
     */
    "/((?!_next/static|_next/image|favicon.ico|public).*)",
  ],
};
