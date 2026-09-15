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
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}

const client = load("../src/lib/workbench-client.ts");
const policy = load("../src/lib/workspace-sync-policy.ts", { "./workbench-client": client });
class ControlError extends Error { constructor(message, status = 502) { super(message); this.status = status; } }
const clone = value => structuredClone(value);
const methods = (...names) => ({ methods: names.map(name => ({ name, available: true })) });

function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    const actual = row[key];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      if (Object.hasOwn(expected, "not")) return actual !== expected.not;
      if (Object.hasOwn(expected, "gt")) return actual > expected.gt;
      if (Object.hasOwn(expected, "lte")) return actual <= expected.lte;
    }
    return actual === expected;
  });
}

function fixture() {
  const realNow = Date.now, previousWorker = global.__agentWorkspaceSync;
  let now = realNow(), createBehavior = "pending", recordFailure = false, gate = null, recordGate = null;
  let immediateResponse = () => ({ result: methods("capabilities") });
  const agents = new Map(), jobs = new Map(), workspaces = new Map(), rows = new Map();
  const calls = [], events = [], polls = [], discoveries = [];
  Date.now = () => now;
  delete global.__agentWorkspaceSync;

  function ensure(id) {
    if (!jobs.has(id)) jobs.set(id, { agentId: id, plan: [], requestId: null, status: "waiting", failures: 0,
      lastAttemptAt: null, lastSuccessAt: null, nextSyncAt: now, leaseToken: null, leaseUntil: null, error: null });
    if (!workspaces.has(id)) workspaces.set(id, { snapshots: {}, conversations: [], activeConversationId: "",
      conversation: null, hasEarlierTurns: false, submission: null });
  }
  function add(id, userId = "owner", identity = true) {
    agents.set(id, { id, urn: `urn:agent:${id}`, name: id, userId, user: { id: userId, virtualUrn: identity ? `urn:console:${userId}` : null } });
    return id;
  }
  function rowFor(id, agentId, method, params = {}, response) {
    const agent = agents.get(agentId);
    const row = { id, agentId, consoleUrn: agent.user.virtualUrn, method,
      requestEnvelope: JSON.stringify({ request_id: id, method, params }), status: response ? "complete" : "pending",
      deadline: new Date(now + 120_000), expiresAt: new Date(now + 600_000), createdAt: new Date(now),
      responseEnvelope: response ? JSON.stringify({ request_id: id, method, ...response }) : null };
    rows.set(id, row); return row;
  }
  const prisma = {
    agent: {
      findMany: async () => [...agents.values()].map(({ id }) => ({ id })),
      findUnique: async ({ where }) => agents.get(where.id) || null,
    },
    controlRequest: {
      findMany: async ({ where, take }) => [...rows.values()].filter(row => matches(row, where)).slice(0, take),
      findFirst: async ({ where }) => [...rows.values()].find(row => matches(row, where)) || null,
      findUnique: async ({ where }) => rows.get(where.id) || null,
      deleteMany: async ({ where }) => {
        let count = 0;
        for (const [id, row] of rows) if (matches(row, where)) { events.push(["delete", id]); rows.delete(id); count++; }
        return { count };
      },
    },
  };
  const store = {
    ensureWorkspaceState: async id => { discoveries.push(id); ensure(id); },
    listDueSyncAgents: async (time, limit) => [...jobs.values()].filter(job => job.nextSyncAt <= time && (!job.leaseUntil || job.leaseUntil <= time)).sort((a, b) => a.nextSyncAt - b.nextSyncAt).slice(0, limit).map(job => job.agentId),
    claimSyncJob: async (id, token, time, leaseMs) => {
      ensure(id); const job = jobs.get(id);
      if (job.nextSyncAt > time || (job.leaseUntil && job.leaseUntil > time)) return false;
      job.leaseToken = token; job.leaseUntil = time + leaseMs; return true;
    },
    readSyncJob: async id => clone(jobs.get(id)),
    updateSyncJob: async (id, update, token) => {
      const job = jobs.get(id);
      if (!job || job.leaseToken !== token) return false;
      Object.assign(job, clone(update)); events.push(["job", id, clone(update)]); return true;
    },
    getWorkspaceAgent: async (userId, id) => {
      const agent = agents.get(id);
      if (!agent || agent.userId !== userId) return null;
      ensure(id); return { ...clone(workspaces.get(id)), agent: clone(agent), identity: { virtualUrn: agent.user.virtualUrn }, sync: clone(jobs.get(id)) };
    },
    getTrackedConversationIds: async (_userId, id) => workspaces.get(id).tracked || [],
    recordWorkspaceResponse: async (_user, agent, row, response) => {
      if (recordGate) await recordGate;
      if (recordFailure) throw new Error("durable workspace unavailable");
      events.push(["persist", row.id]);
      if (!response.error) {
        const workspace = workspaces.get(agent.id);
        workspace.snapshots[row.method] = { data: clone(response.result), time: now, requestId: row.id };
        if (row.method === "collaboration.state") {
          workspace.snapshots["contacts.list"] = { data: { contacts: response.result.contacts || [] }, time: now };
          workspace.snapshots["inbox.list"] = { data: { messages: response.result.inbox || [] }, time: now };
        }
      }
    },
  };
  const service = {
    createControlCall: async (_user, agent, call) => {
      calls.push({ agentId: agent.id, ...clone(call) }); events.push(["enqueue", call.request_id]);
      if (createBehavior === "offline") throw new Error("offline");
      const response = createBehavior === "complete" ? immediateResponse(call, agent) : undefined;
      const row = rowFor(call.request_id, agent.id, call.method, call.params, response);
      if (gate) await gate;
      if (createBehavior === "uncertain") throw new Error("network lost after enqueue");
      return { request_id: row.id, status: row.status };
    },
    pollControlResponses: async user => { polls.push(user.id); },
    controlCallResult: (_user, _agent, row) => {
      if (row.expiresAt.getTime() <= now) throw new ControlError("expired cache", 410);
      return row.responseEnvelope ? { status: "complete", response: JSON.parse(row.responseEnvelope) } : { status: "pending" };
    },
  };
  const dependencies = { "./db": { prisma }, "./control-transport": { ControlError }, "./control-service": service,
    "./workspace-store": store, "./workspace-sync-policy": policy };
  const reload = () => load("../src/lib/workspace-sync.ts", dependencies);
  const ready = (id, capability = methods("capabilities")) => {
    ensure(id); Object.assign(jobs.get(id), { status: "ready", lastSuccessAt: now });
    workspaces.get(id).snapshots.capabilities = { data: clone(capability), time: now };
  };
  return { sync: reload(), reload, agents, jobs, workspaces, rows, calls, events, polls, discoveries, add, ensure, ready, rowFor,
    now: () => now, advance: ms => { now += ms; }, due: id => { jobs.get(id).nextSyncAt = now; },
    setBehavior: value => { createBehavior = value; }, setResponse: value => { immediateResponse = value; },
    setRecordFailure: value => { recordFailure = value; }, setGate: value => { gate = value; },
    setRecordGate: value => { recordGate = value; },
    restore: () => { Date.now = realNow; if (previousWorker === undefined) delete global.__agentWorkspaceSync; else global.__agentWorkspaceSync = previousWorker; } };
}

test("background ticks discover and synchronize saved connections without any browser request", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 6; i++) f.add(`agent-${i}`, `owner-${i % 2}`);
    f.add("no-console", "new-owner", false);
    await f.sync.runWorkspaceSyncTick();
    await f.sync.runWorkspaceSyncTick();
    assert.deepEqual(new Set(f.discoveries), new Set(f.agents.keys()));
    assert.deepEqual(new Set(f.calls.map(call => call.agentId)), new Set([...f.agents.keys()].filter(id => id !== "no-console")));
    assert.ok(f.calls.every(call => call.method === "capabilities"));
    assert.equal(f.jobs.get("no-console").status, "needs_pairing");
  } finally { f.restore(); }
});

test("automatic planning rejects advertised writes and folds contacts and inbox into collaboration state", async () => {
  const f = fixture();
  try {
    f.add("agent"); f.ready("agent", methods("capabilities", "contacts.list", "inbox.list", "collaboration.state", "conversation.get", "conversation.send", "approval.respond", "custom.write"));
    f.workspaces.get("agent").tracked = ["chat", "chat", "bad/id"];
    f.setBehavior("complete");
    f.setResponse(call => ({ result: call.method === "collaboration.state" ? { contacts: [{ contact_id: "alice" }], inbox: [{ message_id: "m1" }] } : { conversation_id: "chat", turns: [] } }));
    await f.sync.runAgentSyncStep("agent");
    await f.sync.runAgentSyncStep("agent");
    assert.deepEqual(f.calls.map(call => call.method), ["collaboration.state", "conversation.get"]);
    assert.deepEqual(f.calls[1].params, { conversation_id: "chat" });
    assert.equal(f.workspaces.get("agent").snapshots["contacts.list"].data.contacts[0].contact_id, "alice");
    assert.equal(f.workspaces.get("agent").snapshots["inbox.list"].data.messages[0].message_id, "m1");
  } finally { f.restore(); }
});

test("capabilities are fetched before data and only explicitly allowed fallback reads are scheduled", async () => {
  const f = fixture();
  try {
    f.add("agent"); f.setBehavior("complete");
    f.setResponse(call => ({ result: call.method === "capabilities" ? { methods: [
      { name: "contacts.list", available: true }, { name: "inbox.list", available: false },
      { name: "conversation.send", available: true }, { name: "approval.respond", available: true },
    ] } : { contacts: [] } }));
    await f.sync.runAgentSyncStep("agent");
    await f.sync.runAgentSyncStep("agent");
    assert.deepEqual(f.calls.map(call => call.method), ["capabilities", "contacts.list"]);
    assert.ok(f.events.findIndex(event => event[0] === "persist") < f.events.findIndex(event => event[0] === "enqueue" && event[1] === f.calls[1].request_id));
  } finally { f.restore(); }
});

test("a live lease prevents concurrent steps from submitting the same agent twice", async () => {
  const f = fixture(); let release;
  try {
    f.add("agent"); f.ready("agent", methods("contacts.list"));
    f.setGate(new Promise(resolve => { release = resolve; }));
    const first = f.sync.runAgentSyncStep("agent");
    while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
    await f.reload().runAgentSyncStep("agent");
    assert.equal(f.calls.length, 1);
    release(); await first;
    assert.equal(f.jobs.get("agent").leaseToken, null);
  } finally { release?.(); f.restore(); }
});

test("restart after request reservation keeps the persisted ID and parameters", async () => {
  const f = fixture();
  try {
    f.add("agent"); f.ready("agent", methods("conversation.get"));
    Object.assign(f.jobs.get("agent"), { requestId: "reserved-request", plan: [{ method: "conversation.get", params: { conversation_id: "saved-chat" } }], leaseToken: "dead-process", leaseUntil: f.now() - 1 });
    await f.reload().runAgentSyncStep("agent");
    assert.deepEqual(f.calls, [{ agentId: "agent", request_id: "reserved-request", method: "conversation.get", params: { conversation_id: "saved-chat" } }]);
    assert.equal(f.jobs.get("agent").requestId, "reserved-request");
  } finally { f.restore(); }
});

test("restart after enqueue and ambiguous network errors poll the original request without resubmission", async () => {
  const f = fixture();
  try {
    f.add("agent"); f.ready("agent", methods("contacts.list")); f.setBehavior("uncertain");
    await f.sync.runAgentSyncStep("agent");
    const id = f.calls[0].request_id;
    assert.ok(f.rows.has(id)); assert.equal(f.jobs.get("agent").requestId, id);
    f.advance(5_000); await f.reload().runAgentSyncStep("agent");
    assert.equal(f.calls.length, 1); assert.deepEqual(f.polls, ["owner"]);
    assert.equal(f.jobs.get("agent").requestId, id);
    const row = f.rows.get(id); row.status = "complete"; row.responseEnvelope = JSON.stringify({ request_id: id, method: "contacts.list", result: { contacts: [] } });
    f.advance(2_000); await f.reload().runAgentSyncStep("agent");
    assert.equal(f.calls.length, 1); assert.equal(f.jobs.get("agent").requestId, null);
    assert.ok(f.workspaces.get("agent").snapshots["contacts.list"]);
  } finally { f.restore(); }
});

test("automatic cache is removed only after durable projection and browser write cache remains intact", async () => {
  const f = fixture();
  try {
    f.add("agent"); f.ready("agent", methods("contacts.list"));
    f.rowFor("browser-write", "agent", "conversation.send", { text: "keep original" }, { result: { status: "submitted" } });
    f.setBehavior("complete"); f.setResponse(() => ({ result: { contacts: [{ contact_id: "alice" }] } }));
    f.setRecordFailure(true); await f.sync.runAgentSyncStep("agent");
    const id = f.calls[0].request_id;
    assert.ok(f.rows.has(id)); assert.ok(f.rows.has("browser-write"));
    assert.equal(f.events.filter(event => event[0] === "delete").length, 0);
    f.setRecordFailure(false); f.advance(5_000); await f.sync.runAgentSyncStep("agent");
    assert.equal(f.rows.has(id), false); assert.ok(f.rows.has("browser-write"));
    assert.ok(f.events.findIndex(event => event[0] === "persist" && event[1] === id) < f.events.findIndex(event => event[0] === "delete" && event[1] === id));
  } finally { f.restore(); }
});

test("persisted jobs cannot turn an advertised write into an automatic enqueue", async () => {
  const f = fixture();
  try {
    f.add("agent"); f.ready("agent", methods("conversation.send"));
    f.jobs.get("agent").plan = [{ method: "conversation.send", params: { text: "must not send" } }];
    await f.sync.runAgentSyncStep("agent");
    assert.equal(f.calls.length, 0); assert.deepEqual(f.jobs.get("agent").plan, []);
  } finally { f.restore(); }
});

test("a worker that lost its lease cannot delete the accepted response needed by its successor", async () => {
  for (const response of [{ result: { contacts: [] } }, { error: { code: "not_paired", message: "revoked" } }]) {
    const f = fixture(); let release;
    try {
      f.add("agent"); f.ready("agent", methods("contacts.list"));
      f.setBehavior("complete"); f.setResponse(() => response);
      f.setRecordGate(new Promise(resolve => { release = resolve; }));
      const first = f.sync.runAgentSyncStep("agent");
      while (!f.calls.length) await new Promise(resolve => setImmediate(resolve));
      const id = f.calls[0].request_id;
      f.advance(policy.SYNC_LEASE_MS + 1);
      Object.assign(f.jobs.get("agent"), { leaseToken: "successor", leaseUntil: f.now() + policy.SYNC_LEASE_MS });
      release(); await first;
      assert.ok(f.rows.has(id), "the successor still owns this request and must be able to project its accepted response");
      assert.equal(f.jobs.get("agent").requestId, id);
      assert.equal(f.jobs.get("agent").leaseToken, "successor");
      assert.equal(f.events.filter(event => event[0] === "delete").length, 0);
      f.setRecordGate(null); f.advance(policy.SYNC_LEASE_MS + 1);
      await f.reload().runAgentSyncStep("agent");
      assert.equal(f.calls.length, 1, "recovery must consume the accepted response without creating a new read");
      assert.equal(f.jobs.get("agent").requestId, null);
      assert.equal(f.rows.has(id), false);
    } finally { release?.(); f.restore(); }
  }
});

test("accepted responses keep retrying durable projection after the request deadline until cache expiry", async () => {
  const f = fixture();
  try {
    f.add("agent"); f.ready("agent", methods("contacts.list"));
    f.setBehavior("complete"); f.setResponse(() => ({ result: { contacts: [{ contact_id: "saved-after-outage" }] } }));
    f.setRecordFailure(true); await f.sync.runAgentSyncStep("agent");
    const id = f.calls[0].request_id;
    f.advance(125_000); await f.reload().runAgentSyncStep("agent");
    assert.equal(f.jobs.get("agent").requestId, id, "a deadline applies to awaiting the response, not projecting an already accepted one");
    assert.ok(f.rows.has(id));
    f.setRecordFailure(false); f.advance(5_000); await f.reload().runAgentSyncStep("agent");
    assert.equal(f.calls.length, 1);
    assert.equal(f.rows.has(id), false);
    assert.equal(f.jobs.get("agent").requestId, null);
    assert.equal(f.workspaces.get("agent").snapshots["contacts.list"].data.contacts[0].contact_id, "saved-after-outage");
  } finally { f.restore(); }
});

test("recovery never consumes a browser write cache even if a persisted job references its ID", async () => {
  for (const response of [undefined, { result: { status: "submitted" } }]) {
    const f = fixture();
    try {
      f.add("agent"); f.ready("agent", methods("contacts.list"));
      f.rowFor("browser-write", "agent", "conversation.send", { text: "original" }, response);
      Object.assign(f.jobs.get("agent"), { requestId: "browser-write", plan: [{ method: "contacts.list", params: {} }] });
      await f.sync.runAgentSyncStep("agent");
      assert.ok(f.rows.has("browser-write"), "automatic recovery must not delete a browser's write ledger");
      assert.equal(f.calls.length, 0); assert.equal(f.polls.length, 0);
      assert.equal(f.events.filter(event => event[0] === "persist").length, 0);
      assert.equal(f.jobs.get("agent").requestId, null);
    } finally { f.restore(); }
  }
});

test("offline backoff preserves saved data and grows without repeatedly querying the unavailable agent", async () => {
  const f = fixture();
  try {
    f.add("agent"); f.ready("agent", methods("contacts.list"));
    f.workspaces.get("agent").snapshots["contacts.list"] = { data: { contacts: [{ contact_id: "cached" }] }, time: f.now() - 60_000 };
    const original = clone(f.workspaces.get("agent").snapshots);
    f.setBehavior("offline"); await f.sync.runAgentSyncStep("agent");
    assert.equal(f.jobs.get("agent").status, "offline"); assert.equal(f.jobs.get("agent").nextSyncAt, f.now() + 30_000);
    await f.sync.runAgentSyncStep("agent"); assert.equal(f.calls.length, 1);
    f.advance(30_000); await f.sync.runAgentSyncStep("agent");
    assert.equal(f.calls[1].method, "capabilities"); assert.equal(f.jobs.get("agent").nextSyncAt, f.now() + 60_000);
    assert.deepEqual(f.workspaces.get("agent").snapshots, original);
  } finally { f.restore(); }
});

test("authenticated pairing errors retain old snapshots and require capability recovery", async () => {
  const f = fixture();
  try {
    f.add("agent"); f.ready("agent", methods("contacts.list"));
    f.workspaces.get("agent").snapshots["contacts.list"] = { data: { contacts: [{ contact_id: "cached" }] }, time: f.now() - 60_000 };
    f.setBehavior("complete"); f.setResponse(() => ({ error: { code: "not_paired", message: "revoked" } }));
    await f.sync.runAgentSyncStep("agent");
    assert.equal(f.jobs.get("agent").status, "needs_pairing");
    assert.equal(f.workspaces.get("agent").snapshots["contacts.list"].data.contacts[0].contact_id, "cached");
    assert.equal(f.jobs.get("agent").nextSyncAt, f.now() + 30_000);
    f.advance(30_000); await f.sync.runAgentSyncStep("agent");
    assert.equal(f.calls[1].method, "capabilities");
  } finally { f.restore(); }
});

test("pending conversations schedule another cycle in five seconds without re-sending their text", async () => {
  const f = fixture();
  try {
    f.add("agent"); f.ready("agent", methods("conversation.get", "conversation.send"));
    Object.assign(f.workspaces.get("agent"), { tracked: ["chat"], conversations: [{ id: "chat", pending: true, title: "saved", updatedAt: f.now(), turnCount: 1 }] });
    f.setBehavior("complete"); f.setResponse(() => ({ result: { conversation_id: "chat", turns: [{ turn_id: "turn", status: "running" }] } }));
    await f.sync.runAgentSyncStep("agent");
    assert.equal(f.jobs.get("agent").nextSyncAt, f.now() + 5_000);
    f.advance(5_000); await f.sync.runAgentSyncStep("agent");
    assert.deepEqual(f.calls.map(call => call.method), ["conversation.get", "conversation.get"]);
    assert.equal(f.rows.size, 0, "finished automatic reads do not fill the browser delivery cache");
  } finally { f.restore(); }
});

test("stale, disconnected, and expired pairing capabilities are refreshed before other reads", async () => {
  const f = fixture();
  try {
    f.add("agent"); f.ready("agent", methods("contacts.list", "conversation.get"));
    const workspace = { ...clone(f.workspaces.get("agent")), sync: { status: "ready" } };
    workspace.snapshots.capabilities.time = f.now() - 120_000;
    assert.deepEqual(policy.syncReadPlan(workspace, ["chat"], f.now()), [{ method: "capabilities", params: {} }]);
    workspace.snapshots.capabilities.time = f.now(); workspace.sync.status = "needs_pairing";
    assert.deepEqual(policy.syncReadPlan(workspace, ["chat"], f.now()), [{ method: "capabilities", params: {} }]);
    workspace.sync.status = "ready";
    workspace.snapshots.capabilities.data.pairing = { expires_at: new Date(f.now() - 1).toISOString() };
    assert.deepEqual(policy.syncReadPlan(workspace, ["chat"], f.now()), [{ method: "capabilities", params: {} }]);
  } finally { f.restore(); }
});
