const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");
const { PrismaClient } = require("@prisma/client");

function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return loaded.exports;
}
class ControlError extends Error { constructor(message, status) { super(message); this.status = status; } }
const client = load("../src/lib/workbench-client.ts");
const migration = fs.readFileSync(path.resolve(__dirname, "../prisma/remote-console.sql"), "utf8");
const migrate = async db => { for (const sql of migration.replace(/^\s*--.*$/gm, "").split(";").filter(s => s.trim())) await db.$executeRawUnsafe(sql); };
async function fixture(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-store-")), filename = path.join(directory, "test.db");
  const db = new PrismaClient({ datasources: { db: { url: "file:" + filename.replaceAll("\\", "/") } } });
  const priorSecret = process.env.NEXTAUTH_SECRET; process.env.NEXTAUTH_SECRET = "isolated-workspace-fixture-secret";
  const makeStore = () => load("../src/lib/workspace-store.ts", { "./db": { prisma: db }, "./control-transport": { ControlError }, "./workbench-client": client });
  try {
    await migrate(db);
    const user = await db.user.create({ data: { id: "owner-a", email: "workspace-a@example.invalid", passwordHash: "fixture", virtualUrn: "urn:console:a" } });
    const other = await db.user.create({ data: { id: "owner-b", email: "workspace-b@example.invalid", passwordHash: "fixture", virtualUrn: "urn:console:b" } });
    const agent = await db.agent.create({ data: { id: "agent-a", userId: user.id, name: "A", urn: "urn:agent:shared", publicKey: "fixture" } });
    const otherAgent = await db.agent.create({ data: { id: "agent-b", userId: other.id, name: "B", urn: "urn:agent:shared", publicKey: "fixture" } });
    const store = makeStore();
    const row = (method, at = Date.now(), id = crypto.randomUUID()) => ({ id, agentId: agent.id, consoleUrn: user.virtualUrn, method, createdAt: new Date(at) });
    const save = (method, data, at, id) => store.recordWorkspaceResponse(user, agent, row(method, at, id), { result: data });
    await run({ db, filename, user, other, agent, otherAgent, store, row, save, makeStore });
  } finally {
    if (priorSecret === undefined) delete process.env.NEXTAUTH_SECRET; else process.env.NEXTAUTH_SECRET = priorSecret;
    await db.$disconnect();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.unlinkSync(filename + suffix);
    fs.rmdirSync(directory);
  }
}

test("workspace retains encrypted snapshots across process reload and isolates accounts", () => fixture(async ({ db, user, other, agent, otherAgent, store, save, makeStore }) => {
  await save("contacts.list", { contacts: [{ contact_id: "contact-1", aliases: ["Private contact text"], urn: "urn:private:contact" }] });
  await save("conversation.get", { conversation_id: "chat", turns: [{ turn_id: "turn-1", text: "Private user text", response: "Private reply text", status: "completed", created_at: 1700000000 }] });
  await store.selectWorkspaceConversation(user.id, agent.id, "chat");
  const reloaded = await makeStore().getWorkspaceAgent(user.id, agent.id);
  assert.equal(reloaded.conversation.turns[0].text, "Private user text");
  assert.equal(reloaded.snapshots["contacts.list"].data.contacts[0].aliases[0], "Private contact text");
  assert.equal(reloaded.conversations[0].title, "Private user text");
  assert.equal(await store.getWorkspaceAgent(other.id, agent.id), null);
  assert.equal((await store.getWorkspaceOverview(other.id)).connections[0].id, otherAgent.id);
  await assert.rejects(store.selectWorkspaceConversation(other.id, agent.id, "chat"), { status: 404 });
  await assert.rejects(store.scheduleWorkspaceSync(other.id, agent.id), { status: 404 });
  const dump = JSON.stringify(await db.$queryRawUnsafe('SELECT "payload" FROM "WorkspaceSnapshot" UNION ALL SELECT "payload" FROM "WorkspaceItem" UNION ALL SELECT "payload" FROM "WorkspaceConversation"'));
  for (const secret of ["Private user text", "Private reply text", "Private contact text", "urn:private:contact"]) assert.equal(dump.includes(secret), false);
  const payload = (await db.$queryRawUnsafe('SELECT "payload" FROM "WorkspaceSnapshot" WHERE "method" = ?', "contacts.list"))[0].payload;
  await db.$executeRawUnsafe('INSERT INTO "WorkspaceSnapshot" ("agentId","method","recordKey","payload","sourceAt","savedAt","requestId") VALUES (?,?,?,?,?,?,?)', otherAgent.id, "contacts.list", "", payload, 1, 1, "copy");
  await assert.rejects(store.getWorkspaceAgent(other.id, otherAgent.id), /authenticat|decrypt|Unsupported state/i, "ciphertext cannot move between accounts even when agent URNs match");
}));

test("late responses cannot replace fresh snapshots and duplicate delivery keeps saved timestamp", () => fixture(async ({ user, agent, store, save }) => {
  const at = Date.now();
  await save("contacts.list", { contacts: [{ aliases: ["fresh"] }] }, at, "new-request");
  const fresh = (await store.getWorkspaceAgent(user.id, agent.id)).snapshots["contacts.list"];
  await save("contacts.list", { contacts: [{ aliases: ["stale"] }] }, at - 1000, "old-request");
  await save("contacts.list", { contacts: [{ aliases: ["fresh"] }] }, at, "new-request");
  const restored = (await store.getWorkspaceAgent(user.id, agent.id)).snapshots["contacts.list"];
  assert.deepEqual(restored, fresh);
  assert.ok(fresh.time >= at);
}));

test("inbox history accumulates and collaboration state projects contacts and inbox", () => fixture(async ({ db, user, agent, store, save }) => {
  const at = Date.now();
  await save("inbox.list", { messages: [{ message_id: "old", text: "Older saved message", received_at: 1700000000 }] }, at);
  await save("collaboration.state", { contacts: [{ contact_id: "friend", aliases: ["Friend"] }], inbox: [{ message_id: "new", text: "New message", received_at: 1700000001 }], tasks: [] }, at + 1);
  await save("inbox.list", { messages: [{ message_id: "new", text: "New message", received_at: 1700000001 }] }, at + 2);
  const workspace = await store.getWorkspaceAgent(user.id, agent.id);
  assert.deepEqual(workspace.snapshots["inbox.list"].data.messages.map(m => m.message_id), ["old", "new"]);
  assert.equal(workspace.snapshots["contacts.list"].data.contacts[0].contact_id, "friend");
  assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceItem" WHERE "kind" = ?', "inbox"))[0].n), 2);
}));

test("100-turn windows merge into durable history with stable same-time pagination", () => fixture(async ({ user, agent, store, save }) => {
  const turn = n => ({ turn_id: `turn-${String(n).padStart(3, "0")}`, text: `Question ${n}`, response: `Answer ${n}`, status: "completed", created_at: 1700000000 });
  const at = Date.now();
  await save("conversation.get", { conversation_id: "history", turns: Array.from({ length: 100 }, (_, n) => turn(n)) }, at);
  await save("conversation.get", { conversation_id: "history", turns: Array.from({ length: 100 }, (_, n) => turn(n + 50)) }, at + 1);
  await store.selectWorkspaceConversation(user.id, agent.id, "history");
  const latest = await store.getWorkspaceAgent(user.id, agent.id);
  assert.equal(latest.conversation.turns.length, 100); assert.equal(latest.hasEarlierTurns, true);
  assert.equal(latest.conversation.turns[0].turn_id, "turn-050");
  const previous = await store.getWorkspaceAgent(user.id, agent.id, "history", "turn-050");
  assert.equal(previous.conversation.turns.length, 50); assert.equal(previous.hasEarlierTurns, false);
  assert.equal(previous.conversation.turns[0].turn_id, "turn-000");
  assert.equal(latest.conversations[0].turnCount, 150);
  await save("conversation.get", { conversation_id: "history", turns: [{ ...turn(149), status: "running" }] }, at - 1000);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).conversation.turns.at(-1).status, "completed");
  await save("conversation.get", { conversation_id: "history", turns: [{ ...turn(149), status: "running", response: null }] }, at + 1000);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).conversation.turns.at(-1).status, "completed");
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).conversation.turns.at(-1).response, "Answer 149");
  await assert.rejects(store.getWorkspaceAgent(user.id, agent.id, "history", "unknown-turn"), { status: 400 });
  await store.selectWorkspaceConversation(user.id, agent.id, null);
  const empty = await store.getWorkspaceAgent(user.id, agent.id);
  assert.equal(empty.activeConversationId, ""); assert.equal(empty.conversation, null);
  await assert.rejects(store.selectWorkspaceConversation(user.id, agent.id, "unknown"), { status: 404 });
}));

test("submission IDs and text survive restart, deduplicate and reconcile without another send", () => fixture(async ({ db, user, agent, store, row, save, makeStore }) => {
  const call = { request_id: "send-a", method: "conversation.send", params: { text: "Private pending text" } };
  await store.reserveWorkspaceSubmission(user, agent, call);
  await store.reserveWorkspaceSubmission(user, agent, call);
  await assert.rejects(store.reserveWorkspaceSubmission(user, agent, { ...call, request_id: "different" }), { status: 409 });
  await assert.rejects(store.reserveWorkspaceSubmission(user, agent, { ...call, params: { text: "changed" } }), { status: 409 });
  await store.markWorkspaceSubmissionUncertain(agent.id, call.request_id);
  const pending = (await makeStore().getWorkspaceAgent(user.id, agent.id)).submission;
  assert.equal(pending.phase, "uncertain"); assert.equal(pending.retryable, true);
  assert.equal(pending.turnId, "turn-" + crypto.createHash("sha256").update(user.virtualUrn + "\0send-a").digest("hex").slice(0, 40));
  assert.deepEqual(pending.call, call);
  assert.equal(JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM "WorkspaceSubmission"')).includes(call.params.text), false);
  await db.$executeRawUnsafe('UPDATE "WorkspaceSubmission" SET "createdAt" = ? WHERE "agentId" = ?', Date.now() - 120001, agent.id);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).submission.retryable, false);
  await assert.rejects(store.reserveWorkspaceSubmission(user, agent, call), { status: 410 });
  await save("conversation.get", { conversation_id: pending.conversationId, turns: [{ turn_id: pending.turnId, text: pending.text, status: "completed", response: "Recovered result" }] });
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).submission, null);
  const call2 = { request_id: "send-b", method: "conversation.send", params: { conversation_id: "chat-b", text: "Accepted user text" } };
  await save("conversation.get", { conversation_id: "chat-b", turns: [] }, Date.now() - 1);
  await store.reserveWorkspaceSubmission(user, agent, call2);
  const pending2 = (await store.getWorkspaceAgent(user.id, agent.id)).submission;
  await store.recordWorkspaceResponse(user, agent, row("conversation.send", Date.now(), call2.request_id), { result: { conversation_id: "chat-b", turn_id: pending2.turnId, status: "submitted" } });
  const accepted = await store.getWorkspaceAgent(user.id, agent.id);
  assert.equal(accepted.submission, null); assert.equal(accepted.activeConversationId, "chat-b");
  assert.equal(accepted.conversation.turns[0].text, call2.params.text);
  assert.equal(accepted.conversations[0].pending, true);
  assert.equal(accepted.conversations[0].title, call2.params.text, "a real message replaces an empty conversation's placeholder title");
  await assert.rejects(store.reserveWorkspaceSubmission(user, agent, call2), { status: 410 }, "a persisted send cannot be recreated after transport-cache expiry");
}));

test("explicit dismissal preserves uncertain text and can later recover an authenticated result", () => fixture(async ({ db, user, other, agent, store, save }) => {
  const call = { request_id: "dismiss-write", method: "conversation.send", params: { text: "Possibly executed instruction" } };
  await store.reserveWorkspaceSubmission(user, agent, call);
  await assert.rejects(store.dismissWorkspaceSubmission(other.id, agent.id, call.request_id), { status: 404 });
  await assert.rejects(store.dismissWorkspaceSubmission(user.id, agent.id, call.request_id), { status: 409 });
  const at = Date.now() - 120001;
  await db.$executeRawUnsafe('UPDATE "WorkspaceSubmission" SET "createdAt" = ? WHERE "agentId" = ?', at, agent.id);
  const pending = (await store.getWorkspaceAgent(user.id, agent.id)).submission;
  assert.equal(pending.phase, "uncertain", "expired sending state recovers after a process crash");
  await store.dismissWorkspaceSubmission(user.id, agent.id, call.request_id);
  const workspace = await store.getWorkspaceAgent(user.id, agent.id, pending.conversationId);
  assert.equal(workspace.submission, null);
  assert.equal(workspace.conversation.turns[0].text, call.params.text);
  assert.equal(workspace.conversation.turns[0].status, "interrupted");
  await assert.rejects(store.reserveWorkspaceSubmission(user, agent, call), { status: 410 });
  await save("conversation.get", { conversation_id: pending.conversationId, turns: [{ turn_id: pending.turnId, text: pending.text, status: "running" }] }, at + 1);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id, pending.conversationId)).conversation.turns[0].status, "running", "a local uncertain marker does not override authenticated progress");
  await save("conversation.get", { conversation_id: pending.conversationId, turns: [{ turn_id: pending.turnId, text: pending.text, status: "completed", response: "Verified completion" }] }, at + 2);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id, pending.conversationId)).conversation.turns[0].response, "Verified completion");
}));

test("authenticated failures preserve user text and use fixed safe summaries before clearing only matching submissions", () => fixture(async ({ db, user, agent, store, row }) => {
  const call = { request_id: "pending-write", method: "conversation.send", params: { text: "Keep this pending" } };
  await store.reserveWorkspaceSubmission(user, agent, call);
  await store.recordWorkspaceResponse(user, agent, row("capabilities", Date.now(), "unrelated"), { error: { code: "not_paired", message: "Private remote exception" } });
  assert.ok((await store.getWorkspaceAgent(user.id, agent.id)).submission);
  await store.recordWorkspaceResponse(user, agent, row(call.method, Date.now(), call.request_id), { error: { code: "denied", message: "Private remote exception" } });
  let workspace = await store.getWorkspaceAgent(user.id, agent.id);
  assert.equal(workspace.submission, null);
  assert.equal(workspace.conversation.turns[0].text, call.params.text);
  assert.equal(workspace.conversation.turns[0].status, "interrupted");
  assert.equal(workspace.conversation.turns[0].locally_unconfirmed, true);
  assert.equal(JSON.stringify(workspace).includes("Private remote exception"), false);
  const refused = { request_id: "refused-write", method: "conversation.send", params: { text: "Preserve rejected user text" } };
  await store.reserveWorkspaceSubmission(user, agent, refused);
  await store.recordWorkspaceResponse(user, agent, row(refused.method, Date.now(), refused.request_id), { error: { code: "queue_full", message: "Private queue exception" } });
  workspace = await store.getWorkspaceAgent(user.id, agent.id);
  assert.equal(workspace.conversation.turns[0].text, refused.params.text);
  assert.equal(workspace.conversation.turns[0].status, "failed");
  assert.equal(workspace.conversation.turns[0].locally_unconfirmed, false);
  assert.equal(JSON.stringify(workspace).includes("Private queue exception"), false);
  assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceSnapshot"'))[0].n), 0);
}));

test("send receipts require exact submitted status and the pending conversation and turn IDs", () => fixture(async ({ db, user, agent, store, row }) => {
  const call = { request_id: "strict-receipt", method: "conversation.send", params: { text: "Keep until proven accepted", conversation_id: "expected-conversation" } };
  await store.reserveWorkspaceSubmission(user, agent, call);
  const pending = (await store.getWorkspaceAgent(user.id, agent.id)).submission;
  const valid = { status: "submitted", conversation_id: pending.conversationId, turn_id: pending.turnId };
  const request = row(call.method, Date.now(), call.request_id);
  for (const result of [{}, { ...valid, status: "accepted" }, { ...valid, conversation_id: "wrong" }, { ...valid, turn_id: "wrong" }, { ...valid, conversation_id: "has spaces" }, { ...valid, turn_id: "" }]) {
    await store.recordWorkspaceResponse(user, agent, request, { result });
    const workspace = await store.getWorkspaceAgent(user.id, agent.id);
    assert.equal(workspace.submission.call.request_id, call.request_id);
    assert.equal(workspace.submission.phase, "uncertain");
    assert.equal(workspace.conversations.length, 0);
    assert.equal(workspace.snapshots["conversation.send"], undefined);
  }
  assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceItem"'))[0].n), 0);
  await store.recordWorkspaceResponse(user, agent, request, { result: valid });
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).submission, null);
  const next = { request_id: "new-pending", method: "conversation.send", params: { text: "New separate message" } };
  await store.reserveWorkspaceSubmission(user, agent, next);
  await store.recordWorkspaceResponse(user, agent, request, { result: valid });
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).submission.call.request_id, next.request_id, "cached receipts cannot clear another pending send");
  await store.recordWorkspaceResponse(user, agent, row(call.method, Date.now(), "legacy-cache"), { result: { status: "submitted", conversation_id: "legacy-conversation", turn_id: "legacy-turn" } });
  assert.ok((await store.getWorkspaceAgent(user.id, agent.id)).conversations.some(c => c.id === "legacy-conversation"));
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).submission.call.request_id, next.request_id);
}));

test("failed encoding only clears submissions that have no durable ControlRequest", () => fixture(async ({ db, user, agent, store }) => {
  const call = { request_id: "enqueue-race", method: "conversation.send", params: { text: "Must preserve queued text" } };
  await store.reserveWorkspaceSubmission(user, agent, call);
  await store.clearWorkspaceSubmission(agent.id, "unrelated-request");
  assert.ok((await store.getWorkspaceAgent(user.id, agent.id)).submission);
  await store.clearWorkspaceSubmission(agent.id, call.request_id);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).submission, null);
  await store.reserveWorkspaceSubmission(user, agent, call);
  await db.controlRequest.create({ data: { id: call.request_id, agentId: agent.id, consoleUrn: user.virtualUrn, method: call.method,
    fingerprint: "fixture", requestEnvelope: "durable encrypted request", deadline: new Date(Date.now() + 120000), expiresAt: new Date(Date.now() + 600000) } });
  await store.clearWorkspaceSubmission(agent.id, call.request_id);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).submission.text, call.params.text, "a concurrent completed enqueue wins over stale encode-failure cleanup");
}));

test("durable sync leases use CAS, survive reload and retain in-flight plans when tabs wake", () => fixture(async ({ db, user, agent, otherAgent, store, makeStore }) => {
  const now = Date.now();
  assert.ok((await store.listDueSyncAgents(now, 10)).includes(agent.id));
  const claims = await Promise.all([store.claimSyncJob(agent.id, "worker-one", now, 10000), store.claimSyncJob(agent.id, "worker-two", now, 10000)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const token = claims[0] ? "worker-one" : "worker-two";
  assert.equal(await store.updateSyncJob(agent.id, { status: "syncing", requestId: "durable-request", plan: [{ method: "conversation.get", params: { conversation_id: "Private job context" } }], nextSyncAt: now + 20000 }, token), true);
  assert.equal(await store.updateSyncJob(agent.id, { requestId: "wrong-worker" }, "stale-lease"), false);
  await store.scheduleWorkspaceSync(user.id, agent.id);
  const job = await makeStore().readSyncJob(agent.id);
  assert.equal(job.requestId, "durable-request"); assert.equal(job.plan[0].params.conversation_id, "Private job context");
  assert.equal((await store.listDueSyncAgents(now + 1, 10)).includes(agent.id), false);
  assert.equal(JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM "WorkspaceState"')).includes("Private job context"), false);
  const wake = (await db.$queryRawUnsafe('SELECT "lastWakeAt" FROM "WorkspaceState" WHERE "agentId" = ?', agent.id))[0].lastWakeAt;
  await store.scheduleWorkspaceSync(user.id, agent.id);
  assert.equal((await db.$queryRawUnsafe('SELECT "lastWakeAt" FROM "WorkspaceState" WHERE "agentId" = ?', agent.id))[0].lastWakeAt, wake);
  assert.equal(await store.claimSyncJob(agent.id, "recovered-worker", now + 11000, 10000), true);
  assert.equal(await store.updateSyncJob(agent.id, { leaseToken: null, leaseUntil: null, status: "ready", lastSuccessAt: now + 11000 }, "recovered-worker"), true);
  assert.equal((await store.getWorkspaceOverview(user.id)).connections[0].sync.status, "ready");
  assert.doesNotThrow(() => JSON.stringify(job));
  const overview = await store.getWorkspaceOverview(user.id);
  assert.doesNotThrow(() => JSON.stringify(overview));
  assert.ok((await store.listDueSyncAgents(now + 11000, 10)).includes(otherAgent.id));
}));

test("additive reruns preserve legacy data and deleting a connection cascades workspace rows only", () => fixture(async ({ db, user, other, agent, otherAgent, store, save }) => {
  await db.$executeRawUnsafe('CREATE TABLE "LegacyContact" ("id" TEXT PRIMARY KEY,"text" TEXT)');
  await db.$executeRawUnsafe('INSERT INTO "LegacyContact" VALUES (?,?)', "legacy", "preserved");
  await save("conversation.get", { conversation_id: "one", turns: [{ turn_id: "one-turn", text: "Encrypted turn", status: "running" }] });
  await store.reserveWorkspaceSubmission(user, agent, { request_id: "pending", method: "conversation.send", params: { text: "Encrypted pending" } });
  await store.ensureWorkspaceState(otherAgent.id);
  await migrate(db); await migrate(db);
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "LegacyContact"'))[0].text, "preserved");
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).conversations[0].turnCount, 1);
  await db.agent.delete({ where: { id: agent.id } });
  for (const table of ["WorkspaceState", "WorkspaceSnapshot", "WorkspaceItem", "WorkspaceConversation", "WorkspaceSubmission"]) {
    assert.equal(Number((await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${table}" WHERE "agentId" = ?`, agent.id))[0].n), 0);
  }
  assert.ok(await store.getWorkspaceAgent(other.id, otherAgent.id));
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "LegacyContact"'))[0].text, "preserved");
}));

test("persisted Web submission can be resumed with native key ordering without replacing its intent", () => fixture(async ({ user, agent, store, makeStore }) => {
  const original = { request_id: "web-native-retry", method: "conversation.send", params: { text: "保留原始消息", conversation_id: "chat-a" } };
  await store.reserveWorkspaceSubmission(user, agent, original);
  await store.markWorkspaceSubmissionUncertain(agent.id, original.request_id);
  const retry = { params: { conversation_id: "chat-a", text: "保留原始消息" }, method: "conversation.send", request_id: original.request_id };
  await makeStore().reserveWorkspaceSubmission(user, agent, retry);
  const saved = (await store.getWorkspaceAgent(user.id, agent.id)).submission;
  assert.deepEqual(saved.call, original);
  assert.equal(saved.phase, "uncertain");
  for (const changed of [{ ...retry, request_id: "different-id" }, { ...retry, params: { ...retry.params, text: "不同指令" } }, { ...retry, params: { ...retry.params, conversation_id: "another-chat" } }]) {
    await assert.rejects(store.reserveWorkspaceSubmission(user, agent, changed), { status: 409 });
  }
  assert.deepEqual((await store.getWorkspaceAgent(user.id, agent.id)).submission.call, original);
}));
