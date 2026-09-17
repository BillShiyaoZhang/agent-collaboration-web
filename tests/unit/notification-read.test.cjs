const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");
const contract = require("@agent-comm/client-contract");

const message = { agentId: "agent one", id: "notice-1", revision: 3, kind: "peer_message_received", state: "open", target: { kind: "inbox", id: "message-1" } };
const support = (methods = [{ name: "inbox.mark_read", available: true }], changes = {}) => ({
  snapshots: { capabilities: { data: { methods, pairing: { expires_at: Date.now() / 1000 + 3600 } } } },
  sync: { status: "ready" }, ...changes,
});
function fixture(workspace = support(), result = { message_id: "message-1", status: "read" }) {
  const calls = [], filename = path.resolve(__dirname, "../../src/components/notification-provider.tsx");
  const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const dependencies = {
    "@/components/workspace-provider": { workspaceRequest: async (url, init = {}) => {
      calls.push({ url, method: init.method || "GET", ...(init.body ? { body: JSON.parse(init.body) } : {}) });
      if (url.endsWith("/workspace")) return workspace;
      return {};
    } },
    "@/lib/notifications/browser-push": {},
    "@agent-comm/client-contract": { ...contract, WorkbenchClient: class {
      constructor(agentId) { this.agentId = agentId; }
      prepare(method, params) { return { method, params }; }
      async execute(call) { calls.push({ rpc: call, agentId: this.agentId }); if (result instanceof Error) throw result; return result; }
    } },
  };
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX }
  }).outputText, filename);
  return { ...loaded.exports, calls, read: item => loaded.exports.confirmNotificationRead(item || message, new AbortController().signal) };
}

test("legacy and ungranted agents disable shared message reads with upgrade and pairing guidance", async () => {
  for (const methods of [[{ name: "inbox.list", available: true }], [{ name: "inbox.mark_read", available: false }]]) {
    const workspace = support(methods), f = fixture(workspace);
    assert.match(f.notificationReadBlockedReason(message, workspace), /升级.*重新配对/);
    await assert.rejects(f.read(), /升级.*重新配对/);
    assert.deepEqual(f.calls, [{ url: "/api/agents/agent%20one/workspace", method: "GET" }], "no unsupported RPC or Web-only read is written");
  }
});

test("missing capability snapshots, expired grants and offline agents cannot acknowledge shared message reads", async () => {
  for (const workspace of [
    support([], { snapshots: {} }),
    support(undefined, { sync: { status: "needs_pairing" } }),
    support(undefined, { sync: { status: "offline" } }),
    { ...support(), snapshots: { capabilities: { data: { methods: [{ name: "inbox.mark_read", available: true }], pairing: { expires_at: 1 } } } } },
  ]) {
    const f = fixture(workspace);
    assert.ok(f.notificationReadBlockedReason(message, workspace));
    await assert.rejects(f.read());
    assert.equal(f.calls.length, 1);
  }
});

test("supported reads require the agent receipt before syncing and acknowledging the exact notification revision", async () => {
  const f = fixture();
  assert.equal(f.notificationReadBlockedReason(message, support()), "");
  await f.read();
  assert.deepEqual(f.calls, [
    { url: "/api/agents/agent%20one/workspace", method: "GET" },
    { rpc: { method: "inbox.mark_read", params: { message_id: "message-1" } }, agentId: "agent one" },
    { url: "/api/workspace/sync", method: "POST", body: { agentId: "agent one" } },
    { url: "/api/notifications", method: "POST", body: { action: "read", agentId: "agent one", id: "notice-1", revision: 3 } },
  ]);
});

test("transport failure, revoked permission and mismatched agent receipts never fall back to a Web-only read", async () => {
  for (const result of [new Error("method_not_allowed"), new Error("offline"), {}, { message_id: "another-message", status: "read" }, { message_id: "message-1", status: "queued" }]) {
    const f = fixture(support(), result);
    await assert.rejects(f.read());
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls.some(call => call.method === "POST"), false);
  }
});

test("approval reminder acknowledgement remains separate from agent decisions for legacy clients", async () => {
  const approval = { ...message, kind: "owner_decision_required", target: { kind: "approval", id: "approval-1" } }, f = fixture(undefined);
  assert.equal(f.notificationReadBlockedReason(approval), "");
  await f.read(approval);
  assert.deepEqual(f.calls, [{ url: "/api/notifications", method: "POST", body: { action: "read", agentId: "agent one", id: "notice-1", revision: 3 } }]);
});

test("already resolved agent notifications do not require another mutation or current pairing", async () => {
  const resolved = { ...message, state: "resolved" }, f = fixture();
  assert.equal(f.notificationReadBlockedReason(resolved), "");
  await f.read(resolved);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].url, "/api/notifications");
});
