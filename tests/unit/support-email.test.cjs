const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { spawnSync } = require("node:child_process");
const crypto = require("node:crypto");
const test = require("node:test");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true, jsx: ts.JsxEmit.ReactJSX } }).outputText, filename);
  return loaded.exports;
}
const support = load("../../src/lib/shared/support-email.ts");

test("support addresses are public, optional and cannot inject a mailto query or executable URL", () => {
  for (const address of [null, "", " ", "javascript:alert(1)", "support@example.invalid?bcc=attacker@example.invalid", "support@example.invalid#fragment", "support@example.invalid\r\nBcc:evil", "<support@example.invalid>", "a".repeat(65) + "@example.invalid"]) {
    assert.equal(support.publicSupportEmail(address), "");
  }
  assert.equal(support.publicSupportEmail(" support@example.invalid "), "support@example.invalid");
  assert.equal(support.publicSupportEmail("support+accounts@example.invalid"), "support+accounts@example.invalid");
});

test("customer-support entry points stay hidden until a valid public address is configured", () => {
  const previous = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
  const footer = load("../../src/components/layout/footer.tsx", { "@/lib/shared/support-email": support });
  const publicFooter = load("../../src/components/public/public-navigation.tsx", {
    "@/lib/shared/support-email": support,
    "./public-navigation.css": {},
    "next/link": ({ children, ...props }) => React.createElement("a", props, children),
  });
  const shell = load("../../src/components/auth-shell.tsx", {
    "@/lib/shared/support-email": support,
    "@/components/brand": { Brand: () => React.createElement("span", null, "Agent Comm") },
    "@/components/ui/input": { Input: () => null },
  });
  const render = () => [
    renderToStaticMarkup(React.createElement(footer.Footer)),
    renderToStaticMarkup(React.createElement(publicFooter.PublicFooter, { language: "zh" })),
    renderToStaticMarkup(React.createElement(publicFooter.PublicFooter, { language: "en" })),
    renderToStaticMarkup(React.createElement(shell.AuthShell, { title: "验证邮箱", description: "确认账号", children: "内容" })),
  ];
  try {
    for (const value of [undefined, "", "invalid-mailbox", "support@example.invalid?bcc=evil@example.invalid"]) {
      if (value === undefined) delete process.env.NEXT_PUBLIC_SUPPORT_EMAIL; else process.env.NEXT_PUBLIC_SUPPORT_EMAIL = value;
      for (const markup of render()) assert.doesNotMatch(markup, /mailto:|联系人工客服|Contact support/);
    }
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL = "support@example.invalid";
    for (const markup of render()) {
      assert.match(markup, /href="mailto:support@example.invalid"/);
      assert.match(markup, /联系人工客服|Contact support/);
    }
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPPORT_EMAIL; else process.env.NEXT_PUBLIC_SUPPORT_EMAIL = previous;
  }
});

test("temporary email failure does not suggest unavailable manual support", () => {
  const previous = process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
  const flow = load("../../src/components/email-auth-flow.tsx", {
    "@/lib/shared/support-email": support,
    "@/lib/auth/login-destination": { safeLoginDestination: value => value || "/dashboard" },
    "@/components/auth-shell": { AuthNotice: () => null, AuthShell: () => null, PasswordInput: () => null },
    "@/components/ui/button": { Button: () => null },
    "@/components/ui/input": { Input: () => null },
    "@/components/ui/label": { Label: () => null },
    "next-auth/react": { signOut: async () => {} },
  });
  try {
    delete process.env.NEXT_PUBLIC_SUPPORT_EMAIL;
    assert.equal(flow.emailActionError(503, {}), "邮件服务暂时不可用，请稍后重试。");
    process.env.NEXT_PUBLIC_SUPPORT_EMAIL = "support@example.invalid";
    assert.match(flow.emailActionError(503, {}), /联系人工客服/);
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_SUPPORT_EMAIL; else process.env.NEXT_PUBLIC_SUPPORT_EMAIL = previous;
  }
});

test("the isolated provider hook permits omitted Reply-To but refuses real reply addresses", () => {
  const fixtureKey = "resend-fixture-" + crypto.randomUUID();
  const hookPath = path.resolve(__dirname, "../integration/email-provider-hook.cjs");
  const script = "(" + function () {
    const assert = require("node:assert/strict");
    let requests = 0;
    globalThis.fetch = async (input, options) => {
      assert.equal(new URL(input).origin, process.env.ACCOUNT_EMAIL_FIXTURE_PROVIDER);
      requests++;
      return Response.json({ id: "fixture-accepted" });
    };
    require(process.argv[1]);
    (async () => {
      const body = { from: "Agent Comm <accounts@notify.example.invalid>", to: ["user@example.invalid"], subject: "synthetic", text: "synthetic" };
      const send = value => fetch("https://api.resend.com/emails", { method: "POST", headers: { authorization: "Bearer " + process.env.RESEND_API_KEY }, body: JSON.stringify(value) });
      assert.equal((await send(body)).status, 200);
      assert.equal((await send({ ...body, reply_to: "support@example.invalid" })).status, 200);
      await assert.rejects(send({ ...body, reply_to: "support@example.com" }), /refuses real addresses/);
      assert.equal(requests, 2);
    })().catch(() => { process.exitCode = 1; });
  }.toString() + ")()";
  const result = spawnSync(process.execPath, ["-e", script, hookPath], {
    env: { ...process.env, NODE_ENV: "development", NEXTAUTH_URL: "http://127.0.0.1:34561", ACCOUNT_EMAIL_FIXTURE_PROVIDER: "http://127.0.0.1:34562", ACCOUNT_EMAIL_FIXTURE_KEY: fixtureKey, RESEND_API_KEY: fixtureKey, NODE_OPTIONS: "" },
    encoding: "utf8", windowsHide: true,
  });
  assert.equal(result.status, 0, "isolated hook checks failed: " + result.stderr);
});
