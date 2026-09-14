const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const { NextRequest } = require("next/server");
const { encode } = require("next-auth/jwt");

// Run the actual middleware and NextAuth implementation without a Next.js server.
const middlewarePath = path.resolve(__dirname, "../src/middleware.ts");
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

    await t.test("allows public login, registration and auth routes without a session", async () => {
      for (const pathname of ["/login", "/register", "/api/auth/session", "/api/auth/callback/credentials"]) {
        assertAllowed(await middleware(request(productionOrigin, pathname)));
      }
    });

    await t.test("retired demo and private APIs are not public routes", async () => {
      for (const pathname of ["/demo", "/demo/private", "/demography", "/api/messages", "/api/contacts", "/login-extra", "/api/auth-extra"]) {
        assertLoginRedirect(await middleware(request(productionOrigin, pathname)), productionOrigin, pathname);
      }
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
