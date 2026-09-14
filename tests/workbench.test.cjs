const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");

const filename = path.resolve(__dirname, "../src/lib/workbench-client.ts");
const loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, filename);
const { WorkbenchClient, WorkbenchError, conversationPending, conversationSettled, records } = loaded.exports;
const signal = () => new AbortController().signal;
const complete = (call, result = {}) => Response.json({
  request_id: call.request_id, status: "complete",
  response: { request_id: call.request_id, method: call.method, result }
});
const fixture = (request, wait = async () => {}) => {
  let count = 0;
  return new WorkbenchClient("agent one", request, wait, () => `request-${++count}`);
};

test("default browser fetch delegate never binds fetch to the RPC client instance", async () => {
  const original = global.fetch;
  global.fetch = function (_url, init) {
    "use strict";
    assert.equal(this, undefined, "native browser fetch rejects a WorkbenchClient receiver");
    return Promise.resolve(complete(JSON.parse(init.body), { contacts: [] }));
  };
  try {
    const client = new WorkbenchClient("agent", undefined, async () => {}, () => "request-1");
    assert.deepEqual(await client.execute(client.prepare("contacts.list"), signal()), { contacts: [] });
  } finally { global.fetch = original; }
});

test("ambiguous send retry preserves the request ID and exact message contents", async () => {
  const sent = [];
  const client = fixture(async (_url, init) => {
    const call = JSON.parse(init.body); sent.push(call);
    if (sent.length === 1) throw new TypeError("connection reset after write");
    return complete(call, { status: "submitted", turn_id: "turn-1", conversation_id: "chat-1" });
  });
  const original = client.prepare("conversation.send", { text: "安排会议" });
  await assert.rejects(client.execute(original, signal()), error => error instanceof WorkbenchError && error.retryable && error.uncertain);
  const retry = client.prepare("conversation.send", { text: "安排会议" });
  assert.strictEqual(retry, original);
  const result = await client.execute(retry, signal());
  assert.equal(result.status, "submitted");
  assert.deepEqual(sent[0], sent[1]);
  assert.notEqual(client.prepare("conversation.send", { text: "安排会议" }).request_id, original.request_id);
});

test("pending transport receipt never becomes an agent result", async () => {
  let call, pending = 0;
  const client = fixture(async (url, init) => {
    assert.match(url, /agent%20one/);
    if (init.method === "POST") { call = JSON.parse(init.body); return Response.json({ request_id: call.request_id, status: "pending" }, { status: 202 }); }
    assert.match(url, new RegExp(`request_id=${call.request_id}`));
    return complete(call, { contacts: [{ contact_id: "alice" }] });
  });
  const result = await client.execute(client.prepare("contacts.list"), signal(), () => { pending++; });
  assert.equal(pending, 1);
  assert.deepEqual(result.contacts, [{ contact_id: "alice" }]);
});

test("expired or missing mutation cache cannot silently create a fresh write", async () => {
  for (const status of [404, 410]) {
    const client = fixture(async () => Response.json({ error: "expired" }, { status }));
    const call = client.prepare("conversation.send", { text: "do work" });
    await assert.rejects(client.execute(call, signal()), error => error.uncertain && !error.retryable);
    assert.strictEqual(client.prepare("conversation.send", { text: "do work" }), call);
  }
  const client = fixture(async () => Response.json({ error: "expired" }, { status: 410 }));
  const read = client.prepare("contacts.list");
  await assert.rejects(client.execute(read, signal()));
  assert.notEqual(client.prepare("contacts.list").request_id, read.request_id);
});

test("expired pending response preserves ambiguous write and does not report completion", async () => {
  const client = fixture(async (_url, init) => Response.json({ request_id: init.body ? JSON.parse(init.body).request_id : "request-1", status: "expired" }));
  const call = client.prepare("conversation.send", { text: "go" });
  await assert.rejects(client.execute(call, signal()), error => error.uncertain && !error.retryable);
  assert.strictEqual(client.prepare("conversation.send", { text: "go" }), call);
});

test("complete responses must correlate to the original request and method", async () => {
  for (const change of ["outer_id", "inner_id", "method", "result_and_error"]) {
    const client = fixture(async (_url, init) => {
      const call = JSON.parse(init.body), body = { request_id: call.request_id, status: "complete", response: { request_id: call.request_id, method: call.method, result: {} } };
      if (change === "outer_id") body.request_id = "other";
      if (change === "inner_id") body.response.request_id = "other";
      if (change === "method") body.response.method = "contacts.list";
      if (change === "result_and_error") body.response.error = { code: "no" };
      return Response.json(body);
    });
    const call = client.prepare("conversation.send", { text: "go" });
    await assert.rejects(client.execute(call, signal()), error => error.uncertain && error.retryable, change);
    assert.strictEqual(client.prepare("conversation.send", { text: "go" }), call);
  }
});

test("authenticated rejection is visible, terminal, and never a successful snapshot", async () => {
  const client = fixture(async (_url, init) => {
    const call = JSON.parse(init.body);
    return Response.json({ request_id: call.request_id, status: "complete", response: { request_id: call.request_id, method: call.method, error: { code: "not_paired", message: "not paired" } } });
  });
  const call = client.prepare("conversation.send", { text: "go" });
  await assert.rejects(client.execute(call, signal()), error => !error.uncertain && !error.retryable && /配对/.test(error.message));
  assert.notEqual(client.prepare("conversation.send", { text: "go" }).request_id, call.request_id);
});

test("unmount cancellation stops polling without recreating the pending action", async () => {
  const controller = new AbortController();
  let requests = 0;
  const client = fixture(async (_url, init) => { requests++; return Response.json({ request_id: JSON.parse(init.body).request_id, status: "pending" }); }, async () => { controller.abort(); throw new DOMException("Aborted", "AbortError"); });
  const call = client.prepare("conversation.send", { text: "go" });
  await assert.rejects(client.execute(call, controller.signal), { name: "AbortError" });
  assert.equal(requests, 1);
  assert.strictEqual(client.prepare("conversation.send", { text: "go" }), call);
});

test("old completed turns and empty snapshots cannot settle the tracked new turn", () => {
  const old = { turn_id: "old", status: "completed", response: "old answer" };
  assert.equal(conversationSettled({ turns: [] }, ["new"]), false);
  assert.equal(conversationSettled({ turns: [old] }, ["new"]), false);
  assert.equal(conversationSettled({ turns: [old, { turn_id: "new", status: "submitted" }] }, ["new"]), false);
  assert.equal(conversationSettled({ turns: [old, { turn_id: "new", status: "running" }] }, ["new"]), false);
  assert.equal(conversationSettled({ turns: [old, { turn_id: "new", status: "unknown" }] }, ["new"]), false);
  for (const status of ["completed", "failed", "interrupted"]) assert.equal(conversationSettled({ turns: [old, { turn_id: "new", status }] }, ["new"]), true);
  assert.equal(conversationPending({ turns: [{ status: "submitted" }] }), true);
  assert.equal(conversationPending({ turns: [{ status: "completed" }] }), false);
  assert.deepEqual(records([null, "bad", [], { status: "running" }]), [{ status: "running" }]);
});
