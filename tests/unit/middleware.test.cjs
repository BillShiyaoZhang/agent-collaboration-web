const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { NextRequest } = require("next/server");
const { encode } = require("next-auth/jwt");

// Run the actual middleware and NextAuth implementation without a Next.js server.
const middlewarePath = path.resolve(__dirname, "../../src/middleware.ts");
const compiled = ts.transpileModule(fs.readFileSync(middlewarePath, "utf8"), {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: middlewarePath,
});
const middlewareModule = new Module(middlewarePath, module);
middlewareModule.filename = middlewarePath;
middlewareModule.paths = Module._nodeModulePaths(path.dirname(middlewarePath));
middlewareModule._compile(compiled.outputText, middlewarePath);
const { middleware } = middlewareModule.exports;

const secret = "middleware-regression-test-secret-not-for-production";
const secureCookie = "__Secure-next-auth.session-token";
const developmentCookie = "next-auth.session-token";
const productionOrigin = "https://agent-communication.online";

function request(origin, pathname, cookie) {
  return new NextRequest(new URL(pathname, origin), {
    headers: cookie ? { cookie } : undefined,
  });
}

function assertAllowed(response) {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-middleware-next"), "1");
  assert.equal(response.headers.get("location"), null);
}

function assertLoginRedirect(response, origin, pathname) {
  assert.equal(response.status, 307);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.origin, origin);
  assert.equal(location.pathname, "/login");
  assert.equal(location.searchParams.get("callbackUrl"), pathname);
  assert.equal(response.headers.get("x-middleware-next"), null);
}

async function assertUnauthorizedJson(response) {
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("x-middleware-next"), null);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.match(response.headers.get("content-type"), /application\/json/);
  assert.deepEqual(await response.json(), { error: "Unauthorized" });
}

test("authentication middleware", { concurrency: false }, async (t) => {
  // NextAuth chooses its default cookie name from NEXTAUTH_URL. Keep all cases
  // serial and restore the caller's environment, including initially unset keys.
  const envKeys = ["NEXTAUTH_URL", "NEXTAUTH_SECRET", "VERCEL"];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  process.env.NEXTAUTH_URL = productionOrigin;
  process.env.NEXTAUTH_SECRET = secret;
  delete process.env.VERCEL;

  try {
    const validToken = await encode({ secret, token: { sub: "regression-user" } });

    await t.test("accepts a valid HTTPS secure session cookie", async () => {
      assertAllowed(await middleware(request(
        productionOrigin, "/dashboard", `${secureCookie}=${validToken}`,
      )));
    });

    await t.test("reassembles valid chunked HTTPS session cookies", async () => {
      const token = await encode({
        secret,
        token: { sub: "regression-user", largeClaim: "x".repeat(9000) },
      });
      const chunks = token.match(/.{1,3800}/g);
      assert.ok(chunks.length > 1, "fixture must exceed one session cookie");
      const cookie = chunks.map((chunk, index) => `${secureCookie}.${index}=${chunk}`)
        .reverse().join("; ");
      assertAllowed(await middleware(request(productionOrigin, "/dashboard", cookie)));
    });

    await t.test("accepts a valid HTTP development session cookie", async () => {
      const origin = "http://localhost:3000";
      process.env.NEXTAUTH_URL = origin;
      try {
        assertAllowed(await middleware(request(
          origin, "/dashboard", `${developmentCookie}=${validToken}`,
        )));
      } finally {
        process.env.NEXTAUTH_URL = productionOrigin;
      }
    });

    await t.test("rejects a missing session and preserves the requested path", async () => {
      const pathname = "/dashboard/agents";
      assertLoginRedirect(await middleware(request(productionOrigin, pathname)), productionOrigin, pathname);
    });

    await t.test("rejects expired sessions", async () => {
      const token = await encode({ secret, token: { sub: "regression-user" }, maxAge: -120 });
      assertLoginRedirect(await middleware(request(
        productionOrigin, "/dashboard", `${secureCookie}=${token}`,
      )), productionOrigin, "/dashboard");
    });

    await t.test("rejects sessions encrypted with another secret", async () => {
      const token = await encode({ secret: "untrusted-secret", token: { sub: "regression-user" } });
      assertLoginRedirect(await middleware(request(
        productionOrigin, "/dashboard", `${secureCookie}=${token}`,
      )), productionOrigin, "/dashboard");
    });

    await t.test("rejects a session marked revoked by the server callback", async () => {
      const token = await encode({ secret, token: { sub: "regression-user", sessionRevoked: true } });
      assertLoginRedirect(await middleware(request(productionOrigin, "/dashboard", `${secureCookie}=${token}`)), productionOrigin, "/dashboard");
    });
    await t.test("rejects arbitrary cookie values", async () => {
      assertLoginRedirect(await middleware(request(
        productionOrigin, "/dashboard", `${secureCookie}=forged; ${developmentCookie}=forged`,
      )), productionOrigin, "/dashboard");
    });

    await t.test("requires the secure cookie name on HTTPS", async () => {
      assertLoginRedirect(await middleware(request(
        productionOrigin, "/dashboard", `${developmentCookie}=${validToken}`,
      )), productionOrigin, "/dashboard");
    });

    await t.test("allows the public app pages, login, registration and auth routes without a session", async () => {
      for (const pathname of ["/", "/docs", "/docs/", "/docs/?path=deploy%2FREADME.md", "/login", "/register", "/forgot-password", "/resend-verification", "/verify-email", "/reset-password", "/confirm-password-change", "/api/auth/session", "/api/auth/callback/credentials"]) {
        assertAllowed(await middleware(request(productionOrigin, pathname)));
      }
    });

    await t.test("allows documentation source requests through to the route allowlist", async () => {
      for (const pathname of ["/docs/source/deploy/README.md", "/docs/source/platform/guides/API.md"]) {
        assertAllowed(await middleware(request(productionOrigin, pathname)));
      }
    });

    await t.test("keeps similarly named pages private", async () => {
      for (const pathname of ["/documentation", "/docs-extra", "/docs/private", "/docs/source-extra/deploy/README.md"]) {
        assertLoginRedirect(await middleware(request(productionOrigin, pathname)), productionOrigin, pathname);
      }
    });

    await t.test("only agent onboarding endpoints bypass the session; claiming stays authenticated", async () => {
      for (const pathname of ["/api/onboarding", "/api/onboarding/11111111-1111-4111-8111-111111111111", "/agent-install.md", "/llms.txt"])
        assertAllowed(await middleware(request(productionOrigin, pathname)));
      for (const pathname of ["/api/onboarding/claim/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "/api/onboarding-extra", "/api/onboarding/11111111-1111-4111-8111-111111111111/private"])
        await assertUnauthorizedJson(await middleware(request(productionOrigin, pathname)));
      assertLoginRedirect(await middleware(request(productionOrigin, "/connect/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")), productionOrigin, "/connect/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    });

    await t.test("retired demo and similarly named pages are not public routes", async () => {
      for (const pathname of ["/demo", "/demo/private", "/demography", "/login-extra", "/verify-email-extra", "/reset-password/private", "/confirm-password-change-extra"]) {
        assertLoginRedirect(await middleware(request(productionOrigin, pathname)), productionOrigin, pathname);
      }
    });

    await t.test("private APIs return uncached JSON instead of redirecting to login", async () => {
      for (const pathname of ["/api/messages", "/api/contacts", "/api/auth-extra", "/api/workspace", "/api/workspace/sync", "/api/agents/agent-one/workspace"]) {
        await assertUnauthorizedJson(await middleware(request(productionOrigin, pathname)));
      }
    });

    await t.test("expired workspace sessions remain recognizable as 401 by background clients", async () => {
      const token = await encode({ secret, token: { sub: "regression-user" }, maxAge: -120 });
      for (const pathname of ["/api/workspace", "/api/agents/agent-one/workspace"]) {
        await assertUnauthorizedJson(await middleware(request(productionOrigin, pathname, `${secureCookie}=${token}`)));
      }
      assertAllowed(await middleware(request(productionOrigin, "/api/workspace", `${secureCookie}=${validToken}`)));
    });

    await t.test("allows the shared footer asset without exposing similarly named routes", async () => {
      assertAllowed(await middleware(request(productionOrigin, "/beian-icon.png")));
      const pathname = "/beian-icon.png/private";
      assertLoginRedirect(await middleware(request(productionOrigin, pathname)), productionOrigin, pathname);
    });
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
  }
});
