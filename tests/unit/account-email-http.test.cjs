const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");
function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return loaded.exports;
}
const passwords = load("../../src/lib/auth/password.ts"), input = load("../../src/lib/shared/http-input.ts");
class AccountEmailError extends Error { constructor(message, status, code) { super(message); this.status = status; this.code = code; } }
test("all account mutations require trusted same origin and bounded validated input; tokens are consumed only by explicit POST", async () => {
  const previous = process.env.NEXTAUTH_URL;
  process.env.NEXTAUTH_URL = "https://console.example.invalid";
  const calls = [], token = "a".repeat(43);
  let session = { user: { id: "account-id" } };
  const helper = load("../../src/lib/auth/account-email-http.ts", {
    "./password": passwords, "./account-email": { AccountEmailError }, "@/lib/shared/http-input": input,
    "./auth": { authOptions: {} }, "next-auth": { getServerSession: async () => session },
  });
  const service = Object.fromEntries(["register", "resendVerification", "verifyEmail", "forgotPassword", "resetPassword", "changePassword", "confirmPasswordChange"].map(name => [name, async (...args) => { calls.push({ name, args }); return { message: "ok" }; }]));
  const cases = [
    ["register", "register", { email: "email@example.invalid", password: "valid-long-password", callbackUrl: "/connect/claim" }, 202],
    ["resend-verification", "resendVerification", { email: "email@example.invalid", callbackUrl: "/connect/claim" }, 202],
    ["verify-email", "verifyEmail", { token }, 200],
    ["forgot-password", "forgotPassword", { email: "email@example.invalid" }, 202],
    ["reset-password", "resetPassword", { token, password: "valid-long-password" }, 200],
    ["change-password", "changePassword", { currentPassword: "old-long-password", password: "valid-long-password" }, 202],
    ["confirm-password-change", "confirmPasswordChange", { token }, 200],
  ];
  const request = (route, body, origin = process.env.NEXTAUTH_URL) => new Request("https://spoofed-host.invalid/api/auth/" + route, { method: "POST", headers: { origin }, body: JSON.stringify(body) });
  try {
    for (const [routeName, method, body, status] of cases) {
      const route = load("../../src/app/api/auth/" + routeName + "/route.ts", { "@/lib/auth/account-email": { accountEmailService: service }, "@/lib/auth/account-email-http": helper, "@/lib/auth/password": passwords });
      assert.equal(route.GET, undefined, "mail scanner GET must not consume an action");
      const before = calls.length;
      const denied = await route.POST(request(routeName, body, "https://spoofed-host.invalid"));
      assert.equal(denied.status, 403); assert.equal(calls.length, before);
      assert.equal((await route.POST(request(routeName, { ...body, extra: true }))).status, 400);
      const large = new Request("https://console.example.invalid", { method: "POST", headers: { origin: process.env.NEXTAUTH_URL }, body: "a".repeat(16385) });
      assert.equal((await route.POST(large)).status, 413); assert.equal(calls.length, before);
      const accepted = await route.POST(request(routeName, body));
      assert.equal(accepted.status, status); assert.match(accepted.headers.get("cache-control"), /private, no-store/);
      assert.equal(accepted.headers.get("referrer-policy"), "no-referrer"); assert.equal(calls.at(-1).name, method);
      if (routeName === "change-password") assert.equal(calls.at(-1).args[0], "account-id");
    }
    session = null;
    const route = load("../../src/app/api/auth/change-password/route.ts", { "@/lib/auth/account-email": { accountEmailService: service }, "@/lib/auth/account-email-http": helper, "@/lib/auth/password": passwords });
    assert.equal((await route.POST(request("change-password", cases[5][2]))).status, 401);
    delete process.env.NEXTAUTH_URL;
    assert.equal((await route.POST(request("change-password", cases[5][2], "https://spoofed-host.invalid"))).status, 503, "Host cannot replace configured trusted origin");
  } finally { if (previous === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = previous; }
});

test("account getter requires a current authenticated session and returns private verification facts", async () => {
  let session = null;
  const facts = { email: "old@example.invalid", emailVerified: false, verificationRequired: false };
  const route = load("../../src/app/api/auth/account/route.ts", {
    "next-auth": { getServerSession: async () => session }, "@/lib/auth/auth": { authOptions: {} },
    "@/lib/auth/account-email": { AccountEmailError, accountEmailService: { account: async id => { assert.equal(id, "old"); return facts; } } },
    "@/lib/auth/account-email-http": { accountEmailHeaders: { "Cache-Control": "private, no-store" }, accountEmailFailure: error => Response.json({ error: error.message, code: error.code }, { status: error.status, headers: { "Cache-Control": "private, no-store" } }) },
  });
  assert.equal((await route.GET()).status, 401);
  session = { user: { id: "old" } };
  const response = await route.GET(); assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), facts); assert.match(response.headers.get("cache-control"), /no-store/);
});
