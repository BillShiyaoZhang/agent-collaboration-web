const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), Module = require("node:module"), test = require("node:test"), ts = require("typescript");
function load(relative, deps = {}, append = "") {
  const filename = path.resolve(__dirname, relative), m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  m.require = name => Object.hasOwn(deps, name) ? deps[name] : Module.prototype.require.call(m, name);
  m._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText + append, filename);
  return m.exports;
}
// Execute the production handlers with a deterministic hook scheduler, as other client unit tests do.
function hooks() {
  const slots = [], pending = [], cleanups = new Map(); let index = 0;
  const changed = (old, deps) => !old || deps.some((value, i) => !Object.is(value, old[i]));
  return {
    React: {
      useState(initial) { const key = index++; if (!(key in slots)) slots[key] = typeof initial === "function" ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === "function" ? next(slots[key]) : next; }]; },
      useRef(initial) { const key = index++; if (!(key in slots)) slots[key] = { current: initial }; return slots[key]; },
      useCallback(callback, deps) { const key = index++; if (changed(slots[key]?.deps, deps)) slots[key] = { callback, deps }; return slots[key].callback; },
      useEffect(callback, deps) { const key = index++; if (changed(slots[key], deps)) { slots[key] = deps; pending.push(() => { cleanups.get(key)?.(); cleanups.set(key, callback()); }); } },
    },
    render(callback) { index = 0; const tree = callback(); for (const effect of pending.splice(0)) effect(); return tree; },
    close() { for (const cleanup of cleanups.values()) cleanup?.(); },
  };
}
function text(node) { if (node == null || typeof node === "boolean") return ""; if (typeof node !== "object") return String(node); if (Array.isArray(node)) return node.map(text).join(""); return text(node.props?.children); }
function find(node, predicate) { if (!node || typeof node !== "object") return null; if (Array.isArray(node)) { for (const child of node) { const hit = find(child, predicate); if (hit) return hit; } return null; } return predicate(node) ? node : find(node.props?.children, predicate); }
const button = (tree, label) => find(tree, node => node.type === "button" && text(node) === label);
const input = (tree, id) => find(tree, node => node.type === "input" && node.props.id === id);
async function settle() { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); }
function fixture() {
  const runtime = hooks(), jsx = (type, props, key) => ({ type, props, key });
  const components = load("../../src/components/workspace-nodes.tsx", {
    react: runtime.React, "react/jsx-runtime": { jsx, jsxs: jsx, Fragment: "fragment" }, "next/link": { default: "link" },
    "lucide-react": { Cable: "icon", ExternalLink: "icon", Loader2: "icon", RefreshCw: "icon" },
    "@/components/ui/button": { Button: "button" }, "@/components/ui/input": { Input: "input" },
    "@/components/local-time": { useLocalTime: () => value => value },
    "@/lib/workspace-nodes/model": load("../../src/lib/workspace-nodes/model.ts"),
  }, "\nexports.TestPortalRequest = portalRequest;");
  return { runtime, request: components.TestPortalRequest, render: () => runtime.render(() => components.WorkspaceEnrollment({ accountId: "owner", accountLabel: "owner@example.invalid" })) };
}

test("enrollment UI issues once per explicit click, copies only the unexpired code, and never claims or stores it", async () => {
  const old = { fetch: global.fetch, setInterval: global.setInterval, clearInterval: global.clearInterval, now: Date.now, clipboard: global.navigator.clipboard };
  let tick, clock = 1000, calls = [], copies = [];
  Date.now = () => clock; global.setInterval = callback => { tick = callback; return 1; }; global.clearInterval = () => {};
  global.navigator.clipboard = { writeText: async value => copies.push(value) };
  const value = { enrollment_token: "E".repeat(43), gateway_url: "https://gateway.workspaces.other.com", expires_at: new Date(301000).toISOString() };
  let release; const pending = new Promise(resolve => { release = resolve; });
  global.fetch = async (url, options) => { calls.push({ url, options }); await pending; return Response.json(value); };
  const ui = fixture();
  try {
    let tree = ui.render(); await settle(); assert.equal(calls.length, 0, "opening/rendering the page never issues an enrollment");
    const generate = button(tree, "生成本机接入码"); generate.props.onClick(); generate.props.onClick();
    await settle(); assert.equal(calls.length, 1, "an in-flight double click cannot generate another code");
    assert.equal(calls[0].url, "/api/workspace-nodes/enroll"); assert.equal(calls[0].options.method, "POST");
    assert.deepEqual(JSON.parse(calls[0].options.body), {}); assert.equal(calls[0].options.headers["X-Workspace-Account"], "owner");
    release(); await settle(); tree = ui.render();
    assert.equal(input(tree, "workspace-enrollment-token").props.value, value.enrollment_token);
    assert.equal(input(tree, "workspace-gateway-public").props.value, value.gateway_url);
    assert.equal(button(tree, "生成本机接入码").props.disabled, true);
    await button(tree, "复制接入码").props.onClick(); await settle(); assert.deepEqual(copies, [value.enrollment_token]);
    clock = 301001; tick(); tree = ui.render(); assert.equal(input(tree, "workspace-enrollment-token"), null);
    assert.match(text(tree), /接入码已到期/); assert.equal(button(tree, "生成本机接入码").props.disabled, false);
    await settle(); assert.equal(calls.length, 1, "expiry never renews, pairs or claims automatically");
    ui.runtime.close();
    const refreshed = fixture(); assert.equal(input(refreshed.render(), "workspace-enrollment-token"), null); refreshed.runtime.close();
    assert.equal(calls.length, 1, "remount never recovers or issues a stored code");
  } finally { ui.runtime.close(); global.fetch = old.fetch; global.setInterval = old.setInterval; global.clearInterval = old.clearInterval; Date.now = old.now; global.navigator.clipboard = old.clipboard; }
});

test("lost issuance and changed-account replies remain empty until another explicit action", async () => {
  const original = global.fetch; let calls = 0;
  global.fetch = async () => { calls++; throw new Error("lost fixture response"); };
  const ui = fixture();
  try {
    button(ui.render(), "生成本机接入码").props.onClick(); await settle(); let tree = ui.render();
    assert.match(text(tree), /lost fixture response/); assert.equal(input(tree, "workspace-enrollment-token"), null);
    await settle(); assert.equal(calls, 1);
    global.fetch = async () => { calls++; return Response.json({ error: "ACCOUNT_CHANGED" }, { status: 409 }); };
    button(tree, "生成本机接入码").props.onClick(); await settle(); tree = ui.render();
    assert.match(text(tree), /登录账户已改变/); assert.equal(input(tree, "workspace-enrollment-token"), null); assert.equal(calls, 2);
  } finally { ui.runtime.close(); global.fetch = original; }
});

test("Gateway Retry-After disables issuance and suppresses reads and retries until the account cooldown ends", async () => {
  const old = { fetch: global.fetch, setTimeout: global.setTimeout, clearTimeout: global.clearTimeout, now: Date.now };
  let clock = 1000, timeout, calls = 0; Date.now = () => clock;
  global.fetch = async () => { calls++; return Response.json({ error: "请求过于频繁，请稍后重试。" }, { status: 429, headers: { "Retry-After": "60" } }); };
  const ui = fixture();
  try {
    button(ui.render(), "生成本机接入码").props.onClick(); await settle();
    global.setTimeout = callback => { timeout = callback; return 1; }; global.clearTimeout = () => {};
    let tree = ui.render(); const blocked = button(tree, "请稍后生成"); assert.equal(blocked.props.disabled, true);
    blocked.props.onClick(); await settle(); assert.equal(calls, 1);
    await assert.rejects(ui.request("owner", "/api/workspace-nodes"), error => error.retryAfter === 60);
    await assert.rejects(ui.request("owner", "/api/workspace-nodes/claim", "POST", { code: "fixture" }), error => error.retryAfter === 60);
    assert.equal(calls, 1, "GET polls and other node operations also respect the account cooldown");
    clock = 61001; timeout(); tree = ui.render(); assert.equal(button(tree, "生成本机接入码").props.disabled, false);
    global.fetch = async () => { calls++; return Response.json({ enrollment_token: "E".repeat(43), expires_at: new Date(clock + 300000).toISOString(), gateway_url: "https://gateway.other.com" }); };
    button(tree, "生成本机接入码").props.onClick(); await settle(); tree = ui.render(); assert.equal(calls, 2);
    assert.ok(input(tree, "workspace-enrollment-token"));
  } finally { ui.runtime.close(); global.fetch = old.fetch; global.setTimeout = old.setTimeout; global.clearTimeout = old.clearTimeout; Date.now = old.now; }
});
