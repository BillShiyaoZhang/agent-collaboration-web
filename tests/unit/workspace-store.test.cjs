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
const client = load("../../src/lib/control/workbench-client.ts");
const migration = fs.readFileSync(path.resolve(__dirname, "../../prisma/remote-console.sql"), "utf8");
const migrate = async db => { for (const sql of migration.replace(/^\s*--.*$/gm, "").split(";").filter(s => s.trim())) await db.$executeRawUnsafe(sql); };
const attentionItem = (changes = {}) => ({ attention_id: "attention-1", kind: "owner_decision_required", subject_id: "approval-1", source_revision: "question-1", revision: 1,
  state: "open", title: "Private approval title", safe_summary: "Private notification summary", target: { kind: "approval", id: "approval-1" }, created_at: 1789430400, updated_at: 1789430400, ...changes });
const attentionPage = (items, cursor, has_more = false) => ({ schema: "agent-comm-attention/v1", items, cursor, has_more });

test("task attention identity survives kind changes and distinct recoveries on the same task stay independent", () => fixture(async ({ user, store, save }) => {
  const target = { kind: "task", id: "shared-task" };
  await save("attention.list", attentionPage([
    attentionItem({ attention_id: "collaboration", kind: "needs_response", target, revision: 1 }),
    attentionItem({ attention_id: "recovery-a", kind: "needs_recovery", target, revision: 2 }),
    attentionItem({ attention_id: "recovery-b", kind: "needs_recovery", target, revision: 3 }),
  ], 3));
  assert.equal((await store.getWorkspaceNotifications(user.id)).pending, 3);
  await save("attention.list", attentionPage([
    attentionItem({ attention_id: "collaboration", kind: "collaboration_completed", target, revision: 4 }),
    attentionItem({ attention_id: "recovery-a", kind: "needs_recovery", target, state: "resolved", revision: 5 }),
  ], 5));
  const page = await store.getWorkspaceNotifications(user.id);
  assert.equal(page.items.length, 3); assert.equal(page.pending, 1);
  assert.equal(page.items[0].state, "resolved", "changed old notifications move to the front");
  assert.equal(page.items[1].kind, "collaboration_completed");
}));

test("expired native presentation leases stay actionable until a known underlying task expires", () => fixture(async ({ user, store, save }) => {
  const approvals = [
    { approval_id: "lease-only", kind: "contact", subject_id: "friend", status: "expired", expires_at: 1700000000, question: "Confirm friend" },
    { approval_id: "task-expired", kind: "task", subject_id: "ended-task", status: "expired", expires_at: 1700000000, question: "Confirm task" },
  ];
  await save("collaboration.state", { pending_confirmations: approvals, tasks: [{ task_id: "ended-task", scope: { expires_at: "2020-01-01T00:00:00Z" } }] });
  const page = await store.getWorkspaceNotifications(user.id);
  const renewable = page.items.find(item => item.target.id === "lease-only");
  assert.equal(renewable.state, "open"); assert.equal(renewable.expiresAt, null); assert.equal(renewable.requiresAction, true);
  assert.equal(page.pending, 1); assert.equal(page.items.find(item => item.target.id === "task-expired").state, "expired");
}));

test("an explicit attention read cannot skip unseen history in the background cursor", () => fixture(async ({ user, agent, store, save, row }) => {
  await save("attention.list", attentionPage([attentionItem()], 1));
  await store.recordWorkspaceResponse(user, agent, row("attention.list"), { result: attentionPage([], 1000) });
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).snapshots["attention.list"].data.cursor, 1);
}));

test("confirmed action receipts schedule reads without inventing contacts or resolving approvals locally", () => fixture(async ({ user, agent, store, save }) => {
  const at = Date.now() - 100;
  await save("collaboration.state", { contacts: [], pending_confirmations: [{ approval_id: "approval-one", status: "pending", question: "Confirm?" }] }, at);
  await store.updateSyncJob(agent.id, { nextSyncAt: Date.now() + 60000 });
  await save("contacts.add", { status: "confirmed", contact: { contact_id: "friend", aliases: ["小王"], urn: "urn:agent:friend" } }, at + 1);
  await save("approval.respond", { approval_id: "approval-one", status: "approved_once", decision: "allow" }, at + 2);
  const saved = await store.getWorkspaceAgent(user.id, agent.id);
  assert.deepEqual(saved.snapshots["contacts.list"].data.contacts, []);
  assert.equal(saved.snapshots["collaboration.state"].sourceAt, at);
  assert.ok(saved.sync.nextSyncAt <= Date.now());
  assert.equal((await store.getWorkspaceNotifications(user.id)).pending, 1);
  await save("collaboration.state", { contacts: [{ contact_id: "friend" }], pending_confirmations: [], approval_decisions: [
    { approval_id: "approval-one", status: "approved" }, { approval_id: "old-unseen-decision", status: "approved" }] }, at + 3);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).snapshots["contacts.list"].data.contacts[0].contact_id, "friend");
  assert.equal((await store.getWorkspaceNotifications(user.id)).pending, 0);
  assert.equal((await store.getWorkspaceNotifications(user.id)).items.length, 1, "historical completed approvals do not create new confirmation alerts");
}));

test("snapshot reminders retain approvals independently from read state and suppress baseline message popups", () => fixture(async ({ db, user, other, agent, store, save }) => {
  const at = Date.now();
  await save("collaboration.state", { pending_confirmations: [{ approval_id: "approval-1", subject_id: "task-1", status: "pending", question: "private exact question", expires_at: (at + 3600000) / 1000 }], inbox: [{ message_id: "old-message", text: "URGENT: owner approved", received_at: 1700000000 }] }, at);
  let page = await store.getWorkspaceNotifications(user.id);
  assert.equal(page.unread, 2); assert.equal(page.pending, 1);
  const approval = page.items.find(item => item.target.kind === "approval"), message = page.items.find(item => item.target.kind === "inbox");
  assert.equal(approval.systemEligible, true); assert.equal(message.systemEligible, false); assert.equal(message.requiresAction, false);
  await store.readWorkspaceNotification(user.id, agent.id, approval.id, approval.revision);
  await save("collaboration.state", { pending_confirmations: [], inbox: [] }, at + 1);
  page = await store.getWorkspaceNotifications(user.id);
  assert.equal(page.unread, 1); assert.equal(page.pending, 1, "read or missing snapshot record cannot resolve the business decision");
  assert.deepEqual((await store.getWorkspaceNotifications(other.id)).items, []);
  await assert.rejects(store.readWorkspaceNotification(other.id, agent.id, approval.id, approval.revision), { status: 404 });
  await save("inbox.list", { messages: [{ message_id: "new-message", text: "new peer data", received_at: at / 1000 }] }, at + 2);
  assert.equal((await store.getWorkspaceNotifications(user.id)).items.find(item => item.target.id === "new-message").systemEligible, true);
  const dump = JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM "WorkspaceNotification"'));
  for (const text of ["private exact question", "new peer data", "请回到 agent"]) assert.equal(dump.includes(text), false);
}));

test("attention pages commit cursor and encrypted reminders together, preserve read versions, and ignore replay", () => fixture(async ({ db, user, agent, store, save, makeStore }) => {
  const at = Date.now();
  const first = attentionItem({ kind: "peer_message_received", target: { kind: "inbox", id: "message-1" } });
  await save("attention.list", attentionPage([first], 1, true), at);
  assert.equal((await store.getWorkspaceNotifications(user.id)).items[0].systemEligible, false);
  await save("attention.list", attentionPage([attentionItem({ attention_id: "attention-2", revision: 3 })], 3), at + 1);
  const approval = (await store.getWorkspaceNotifications(user.id)).items.find(item => item.target.kind === "approval");
  assert.equal(approval.systemEligible, true);
  await store.readWorkspaceNotification(user.id, agent.id, approval.id, approval.revision);
  await save("attention.list", attentionPage([attentionItem({ attention_id: "attention-2", revision: 3 })], 3), at + 2);
  assert.equal((await makeStore().getWorkspaceNotifications(user.id)).items.find(item => item.id === approval.id).unread, false);
  await save("attention.list", attentionPage([attentionItem({ attention_id: "attention-2", revision: 4, source_revision: "question-2" })], 4), at + 3);
  await assert.rejects(store.readWorkspaceNotification(user.id, agent.id, approval.id, approval.revision), { status: 409 });
  const updated = (await store.getWorkspaceNotifications(user.id)).items.find(item => item.id === approval.id);
  assert.equal(updated.revision, approval.revision + 1); assert.equal(updated.unread, true);
  await save("attention.list", attentionPage([attentionItem({ attention_id: "attention-2", revision: 5, state: "resolved", source_revision: "question-2" })], 5), at + 4);
  await save("attention.list", attentionPage([attentionItem()], 1), at + 5);
  assert.equal((await store.getWorkspaceNotifications(user.id)).pending, 0);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).snapshots["attention.list"].data.cursor, 5);
  const dump = JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM "WorkspaceNotification"'));
  assert.equal(dump.includes("Private approval title"), false); assert.equal(dump.includes("Private notification summary"), false);
}));

test("malformed feed cannot partially insert notifications or advance continuation", () => fixture(async ({ user, agent, store, save }) => {
  await save("attention.list", attentionPage([attentionItem()], 1));
  const invalid = attentionItem({ attention_id: "bad-item", revision: 9, target: { kind: "approval", id: "new-approval" } });
  await assert.rejects(save("attention.list", attentionPage([attentionItem({ revision: 2 }), invalid], 2)), /Invalid attention/);
  assert.equal((await store.getWorkspaceNotifications(user.id)).items.length, 1);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).snapshots["attention.list"].data.cursor, 1);
  await assert.rejects(save("attention.list", attentionPage([], 1, true)), /does not advance/);
}));

test("system-notification claims coordinate tabs, isolate devices, and never modify approval or unread state", () => fixture(async ({ user, other, agent, store, save }) => {
  await save("attention.list", attentionPage([attentionItem()], 1));
  const item = (await store.getWorkspaceNotifications(user.id)).items[0];
  const claim = device => store.claimWorkspaceNotification(user.id, agent.id, item.id, item.revision, device);
  const results = await Promise.all([claim("device-a"), claim("device-a")]);
  assert.deepEqual(results.sort(), [false, true]);
  assert.equal(await claim("device-b"), true);
  await assert.rejects(store.claimWorkspaceNotification(other.id, agent.id, item.id, item.revision, "device-a"), { status: 404 });
  let page = await store.getWorkspaceNotifications(user.id); assert.equal(page.unread, 1); assert.equal(page.pending, 1);
  await store.readWorkspaceNotification(user.id, agent.id, item.id, item.revision);
  assert.equal(await claim("device-c"), false);
  page = await store.getWorkspaceNotifications(user.id); assert.equal(page.unread, 0); assert.equal(page.pending, 1);
}));

test("expired, completed, and recovery items keep separate actionable meanings and cascade with their connection", () => fixture(async ({ db, user, agent, store, save }) => {
  await save("attention.list", attentionPage([
    attentionItem({ expires_at: 1700000000 }),
    attentionItem({ attention_id: "done", kind: "collaboration_completed", target: { kind: "task", id: "task-done" }, revision: 2 }),
    attentionItem({ attention_id: "recover", kind: "needs_recovery", target: { kind: "task", id: "task-recover" }, revision: 3 }),
    attentionItem({ attention_id: "reply", kind: "needs_response", target: { kind: "task", id: "task-reply" }, revision: 4 }),
  ], 4));
  const page = await store.getWorkspaceNotifications(user.id); assert.equal(page.pending, 2);
  const expired = page.items.find(item => item.target.kind === "approval"); assert.equal(expired.state, "expired"); assert.equal(expired.requiresAction, false);
  assert.equal(await store.claimWorkspaceNotification(user.id, agent.id, expired.id, expired.revision, "device"), false);
  await db.agent.delete({ where: { id: agent.id } });
  assert.equal((await store.getWorkspaceNotifications(user.id)).items.length, 0);
  assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceNotificationBaseline"'))[0].n), 0);
}));
async function fixture(run, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-store-")), filename = path.join(directory, "test.db");
  const url = "file:" + filename.replaceAll("\\", "/") + (options.singleConnection ? "?connection_limit=1" : "");
  const db = new PrismaClient({ datasources: { db: { url } } });
  const priorSecret = process.env.NEXTAUTH_SECRET; process.env.NEXTAUTH_SECRET = "isolated-workspace-fixture-secret";
  const makeStore = () => load("../../src/lib/workspace/workspace-store.ts", { "@/lib/shared/db": { prisma: db }, "@/lib/control/control-transport": { ControlError }, "@/lib/control/workbench-client": client });
  try {
    await migrate(db);
    const user = await db.user.create({ data: { id: "owner-a", email: "workspace-a@example.invalid", passwordHash: "fixture", virtualUrn: "urn:console:a" } });
    const other = await db.user.create({ data: { id: "owner-b", email: "workspace-b@example.invalid", passwordHash: "fixture", virtualUrn: "urn:console:b" } });
    const agent = await db.agent.create({ data: { id: "agent-a", userId: user.id, name: "A", urn: "urn:agent:shared", publicKey: "fixture" } });
    const otherAgent = await db.agent.create({ data: { id: "agent-b", userId: other.id, name: "B", urn: "urn:agent:shared", publicKey: "fixture" } });
    const store = makeStore();
    const row = (method, at = Date.now(), id = crypto.randomUUID()) => ({ id, agentId: agent.id, consoleUrn: user.virtualUrn, method, createdAt: new Date(at) });
    const save = async (method, data, at, id) => {
      const request = row(method, at, id);
      if (method === "attention.list") {
        const current = await store.getWorkspaceAgent(user.id, agent.id);
        await store.updateSyncJob(agent.id, { requestId: request.id, plan: [{ method, params: { after: current.snapshots[method]?.data.cursor || 0, limit: 100 } }] });
      }
      return store.recordWorkspaceResponse(user, agent, request, { result: data });
    };
    await run({ db, filename, user, other, agent, otherAgent, store, row, save, makeStore });
  } finally {
    if (priorSecret === undefined) delete process.env.NEXTAUTH_SECRET; else process.env.NEXTAUTH_SECRET = priorSecret;
    await db.$disconnect();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.unlinkSync(filename + suffix);
    fs.rmdirSync(directory);
  }
}

test("concurrent projections and account reads remain correct with one SQLite connection", () => fixture(async ({ user, other, agent, otherAgent, store, row }) => {
  const sourceAt = Date.now() - 100;
  const writes = Array.from({ length: 8 }, (_, index) => [
    store.recordWorkspaceResponse(user, agent, row("contacts.list", sourceAt + index, `a-${index}`),
      { result: { contacts: [{ contact_id: `a-${index}` }] } }),
    store.recordWorkspaceResponse(other, otherAgent,
      { ...row("contacts.list", sourceAt + index, `b-${index}`), agentId: otherAgent.id, consoleUrn: other.virtualUrn },
      { result: { contacts: [{ contact_id: `b-${index}` }] } }),
  ]).flat();
  await Promise.all([
    ...writes,
    store.scheduleWorkspaceSync(user.id, agent.id),
    store.scheduleWorkspaceSync(other.id, otherAgent.id),
    store.getWorkspaceOverview(user.id),
    store.getWorkspaceOverview(other.id),
  ]);
  const [a, b] = await Promise.all([
    store.getWorkspaceAgent(user.id, agent.id),
    store.getWorkspaceAgent(other.id, otherAgent.id),
  ]);
  assert.equal(a.snapshots["contacts.list"].data.contacts[0].contact_id, "a-7");
  assert.equal(b.snapshots["contacts.list"].data.contacts[0].contact_id, "b-7");
  assert.deepEqual(new Set(await store.listDueSyncAgents(Date.now(), 10)), new Set([agent.id, otherAgent.id]));
  assert.equal(await store.getWorkspaceAgent(user.id, otherAgent.id), null);
}, { singleConnection: true }));

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

test("explicit policy confirmation wakes sync even inside the ordinary UI throttle window", () => fixture(async ({ db, user, agent, store }) => {
  const now = Date.now();
  await store.ensureWorkspaceState(agent.id);
  await db.$executeRaw`UPDATE "WorkspaceState" SET "nextSyncAt" = ${now + 60000}, "lastWakeAt" = ${now}
    WHERE "agentId" = ${agent.id}`;
  await store.scheduleWorkspaceSync(user.id, agent.id);
  assert.ok((await store.readSyncJob(agent.id)).nextSyncAt > now, "ordinary UI wake remains throttled");
  await store.scheduleWorkspaceSync(user.id, agent.id, true);
  assert.ok((await store.readSyncJob(agent.id)).nextSyncAt <= Date.now(), "explicit consent bypasses the wake throttle");
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

test("projection retries explicit SQLite busy errors by rolling back and rerunning the whole transaction", async () => {
  for (const fields of [{ code: "P2010", meta: { code: "5" } }, { code: "P2010", meta: { code: 5 } },
    { code: "SQLITE_BUSY" }, { code: "P2010", meta: { code: "SQLITE_BUSY" } }]) {
    await fixture(async ({ db, user, agent, store, save }) => {
      const transaction = db.$transaction.bind(db), busy = Object.assign(new Error("database is locked"), fields);
      let attempts = 0;
      db.$transaction = async (work, options) => {
        const attempt = ++attempts;
        try {
          return await transaction(async tx => {
            await work(tx);
            if (attempt === 1) throw busy;
          }, options);
        } catch (error) {
          assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceItem"'))[0].n), 0,
            "all writes from the failed attempt must roll back before retry");
          throw error;
        }
      };
      await save("conversation.get", { conversation_id: "busy-chat", turns: [
        { turn_id: "busy-turn", text: "Original question", response: "Authenticated answer", status: "completed" },
      ] }, Date.now(), "stable-read-request");
      assert.equal(attempts, 2);
      const result = await store.getWorkspaceAgent(user.id, agent.id, "busy-chat");
      assert.equal(result.snapshots["conversation.get"].requestId, "stable-read-request");
      assert.equal(result.conversation.turns.length, 1);
      assert.equal(result.conversation.turns[0].response, "Authenticated answer");
    });
  }
});

test("projection retries are bounded and ordinary database failures are not retried", async () => {
  const cases = [
    [Object.assign(new Error("busy"), { code: "P2010", meta: { code: "5" } }), 4],
    [new Error("database is locked"), 1],
    [Object.assign(new Error("constraint"), { code: "P2010", meta: { code: "19" } }), 1],
    [Object.assign(new Error("timeout"), { code: "P1008" }), 1],
  ];
  for (const [failure, expectedAttempts] of cases) {
    await fixture(async ({ db, user, agent, store, save }) => {
      const data = { conversation_id: "existing", turns: [{ turn_id: "kept", response: "Saved answer", status: "completed" }] };
      await save("conversation.get", data, Date.now(), "original-result");
      const before = await store.getWorkspaceAgent(user.id, agent.id, "existing");
      const transaction = db.$transaction.bind(db);
      let attempts = 0;
      db.$transaction = (work, options) => transaction(async tx => {
        attempts++;
        await work(tx);
        throw failure;
      }, options);
      await assert.rejects(save("conversation.get", { ...data, turns: [{ turn_id: "uncommitted", status: "running" }] },
        Date.now() + 1, "failed-result"), error => error === failure);
      assert.equal(attempts, expectedAttempts);
      assert.deepEqual(await store.getWorkspaceAgent(user.id, agent.id, "existing"), before,
        "failure exhaustion cannot erase or partially replace the saved result");
    });
  }
});

test("real SQLite transaction-start contention retries only before projection begins", () => fixture(async ({ db, filename, user, agent, store, row }) => {
  await store.ensureWorkspaceState(agent.id);
  const other = new PrismaClient({ datasources: { db: { url: "file:" + filename.replaceAll("\\", "/") } } });
  const otherStore = load("../../src/lib/workspace/workspace-store.ts", { "@/lib/shared/db": { prisma: other }, "@/lib/control/control-transport": { ControlError }, "@/lib/control/workbench-client": client });
  let release, acquired, lockedWrite;
  const held = new Promise(resolve => { release = resolve; });
  const locked = new Promise(resolve => { acquired = resolve; });
  const failures = [];
  let attempts = 0;
  try {
    await other.$queryRawUnsafe("PRAGMA busy_timeout = 1");
    const transaction = other.$transaction.bind(other);
    other.$transaction = async (work, options) => {
      attempts++;
      try { return await transaction(work, options); }
      catch (error) { failures.push(error); release(); throw error; }
    };
    lockedWrite = db.$transaction(async tx => {
      await tx.$executeRaw`UPDATE "WorkspaceState" SET "lastAttemptAt" = ${123456} WHERE "agentId" = ${agent.id}`;
      acquired();
      await held;
    }, { timeout: 10000 });
    await locked;
    const request = row("conversation.get"), response = {
      result: { conversation_id: "concurrent", turns: [{ turn_id: "concurrent-turn", response: "Actual result", status: "completed" }] },
    };
    await otherStore.recordWorkspaceResponse(user, agent, request, response);
    await lockedWrite;
    assert.equal(failures.length, 1);
    assert.equal(failures[0].code, "P1008");
    assert.equal(attempts, 2, "the rolled-back transaction starts again after its writer is released");
    await otherStore.recordWorkspaceResponse(user, agent, request, response);
    assert.equal(attempts, 3, "a replay of the same authenticated result remains safe");
    const result = await store.getWorkspaceAgent(user.id, agent.id, "concurrent");
    assert.equal(result.conversation.turns[0].response, "Actual result");
    assert.equal(result.sync.lastAttemptAt, 123456);
    assert.equal(result.conversation.turns.length, 1);
  } finally {
    release();
    await lockedWrite;
    await other.$disconnect();
  }
}));

test("ensuring an existing workspace state does not acquire a SQLite writer lock", () => fixture(async ({ db, filename, agent, store }) => {
  await store.ensureWorkspaceState(agent.id);
  const writer = new PrismaClient({ datasources: { db: { url: "file:" + filename.replaceAll("\\", "/") } } });
  let signalLocked, releaseWriter;
  const locked = new Promise(resolve => { signalLocked = resolve; });
  const release = new Promise(resolve => { releaseWriter = resolve; });
  const transaction = writer.$transaction(async tx => {
    await tx.$executeRaw`UPDATE "WorkspaceState" SET "lastAttemptAt" = ${123456} WHERE "agentId" = ${agent.id}`;
    signalLocked();
    await release;
  }, { timeout: 10000 });
  await locked;
  const ensuring = store.ensureWorkspaceState(agent.id);
  let completed = false;
  ensuring.then(() => { completed = true; }, () => { completed = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(completed, true, "the existing row is checked without a no-op INSERT");
    await ensuring;
  } finally {
    releaseWriter();
    await transaction;
    await ensuring.catch(() => {});
    await writer.$disconnect();
  }
}));

test("standalone sync writes retry a real SQLite writer lock without repeating a job", () => fixture(async ({ db, filename, user, agent, otherAgent }) => {
  const contender = new PrismaClient({ datasources: { db: { url: "file:" + filename.replaceAll("\\", "/") } } });
  const contenderStore = load("../../src/lib/workspace/workspace-store.ts", {
    "@/lib/shared/db": { prisma: contender }, "@/lib/control/control-transport": { ControlError }, "@/lib/control/workbench-client": client,
  });
  try {
    await contender.$queryRawUnsafe("PRAGMA busy_timeout = 1");
    await contenderStore.ensureWorkspaceState(agent.id);
    async function contend(action) {
      let signalLocked, releaseWriter;
      const locked = new Promise(resolve => { signalLocked = resolve; });
      const release = new Promise(resolve => { releaseWriter = resolve; });
      const writer = db.$transaction(async tx => {
        await tx.$executeRaw`UPDATE "User" SET "email" = "email" WHERE "id" = ${user.id}`;
        signalLocked();
        await release;
      }, { timeout: 10000 });
      await locked;
      const execute = contender.$executeRaw.bind(contender);
      const failures = [];
      let attempts = 0;
      contender.$executeRaw = async (...args) => {
        attempts++;
        try { return await execute(...args); }
        catch (error) { failures.push(error); releaseWriter(); await writer; throw error; }
      };
      try {
        const result = await action();
        await writer;
        assert.equal(attempts, 2, "the same standalone statement is retried once");
        assert.equal(failures.length, 1);
        assert.equal(failures[0].code, "P2010");
        assert.equal(String(failures[0].meta?.code), "5");
        return result;
      } finally {
        releaseWriter();
        await writer;
        contender.$executeRaw = execute;
      }
    }
    await contend(() => contenderStore.ensureWorkspaceState(otherAgent.id));
    assert.equal((await contender.$queryRaw`SELECT COUNT(*) AS "n" FROM "WorkspaceState" WHERE "agentId" = ${otherAgent.id}`)[0].n, 1n);
    const token = crypto.randomUUID(), now = Date.now();
    assert.equal(await contend(() => contenderStore.claimSyncJob(agent.id, token, now, 60000)), true);
    assert.equal(await contend(() => contenderStore.updateSyncJob(agent.id, { status: "ready" }, token)), true);
    assert.equal((await contenderStore.readSyncJob(agent.id)).leaseToken, token);
    await contenderStore.updateSyncJob(agent.id, { nextSyncAt: Date.now() + 60000, leaseToken: null, leaseUntil: null }, token);
    await contend(() => contenderStore.scheduleWorkspaceSync(user.id, agent.id));
    const [job] = await contender.$queryRaw`SELECT "nextSyncAt", "lastWakeAt" FROM "WorkspaceState" WHERE "agentId" = ${agent.id}`;
    assert.ok(job.nextSyncAt <= Date.now());
    assert.equal(job.lastWakeAt, job.nextSyncAt, "the same wake time is reused across retries");
  } finally { await contender.$disconnect(); }
}));

test("agent snapshots carry friend decisions and resolve read messages without mutating from receipts", () => fixture(async ({ user, agent, store, save }) => {
  const time = Date.now() - 500;
  const request = { request_id: "request-a", direction: "incoming", peer_urn: "urn:agent:friend", status: "pending" };
  const message = { message_id: "message-a", sender_urn: "urn:agent:friend", text: "hello", read: false };
  await save("collaboration.state", { contacts: [], contact_requests: [request], inbox: { messages: [message] } }, time);
  let workspace = await store.getWorkspaceAgent(user.id, agent.id);
  assert.deepEqual(workspace.snapshots["contacts.requests"].data.contact_requests, [request]);
  assert.equal(workspace.snapshots["inbox.list"].data.messages[0].read, false);
  await save("inbox.mark_read", { message_id: "message-a", status: "read" }, time + 1);
  await save("contacts.respond", { request_id: "request-a", status: "accepted" }, time + 2);
  workspace = await store.getWorkspaceAgent(user.id, agent.id);
  assert.equal(workspace.snapshots["inbox.list"].data.messages[0].read, false, "receipt never invents an agent snapshot");
  assert.equal(workspace.snapshots["contacts.requests"].data.contact_requests[0].status, "pending");
  await save("collaboration.state", { contacts: [{ urn: "urn:agent:friend", connection_status: "connected", presence: { status: "online", expires_at: 9999999999 } }], contact_requests: [{ ...request, status: "accepted" }], inbox: { messages: [{ ...message, read: true }] } }, time + 3);
  workspace = await store.getWorkspaceAgent(user.id, agent.id);
  assert.equal(workspace.snapshots["contacts.list"].data.contacts[0].presence.status, "online");
  assert.equal(workspace.snapshots["contacts.requests"].data.contact_requests[0].status, "accepted");
  assert.equal(workspace.snapshots["inbox.list"].data.messages[0].read, true);
  assert.equal((await store.getWorkspaceNotifications(user.id)).items.find(item => item.target.id === "message-a").state, "resolved");
}));


test("resolved agent attention closes an old cached message outside the latest inbox and clears unread counts", () => fixture(async ({ user, agent, store, save }) => {
  const time = Date.now() - 100;
  await save("inbox.list", { messages: [{ message_id: "old-message", sender_urn: "urn:agent:friend", text: "old", read: false }] }, time);
  await save("attention.list", attentionPage([attentionItem({ attention_id: "inbox:old-message", kind: "peer_message_received", subject_id: "old-message", target: {kind:"inbox",id:"old-message"}, state: "resolved" })], 1), time + 1);
  const data = await store.getWorkspaceAgent(user.id, agent.id);
  assert.equal(data.snapshots["inbox.list"].data.messages[0].read, true);
  const page = await store.getWorkspaceNotifications(user.id);
  assert.equal(page.unread, 0); assert.equal(page.items[0].unread, false);
  await save("inbox.list", { messages: [{ message_id: "old-message", read: false }] }, time + 2);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).snapshots["inbox.list"].data.messages[0].read, true);
}));


test("encrypted account operation ledger keeps the exact request across reload and rejects changed IDs/content", () => fixture(async ({ db, user, other, agent, store, makeStore, save }) => {
  const call = { request_id: crypto.randomUUID(), method: "messages.send", params: { recipient_urn: "urn:agent:friend", message_id: "stable-message", text: "PRIVATE OPERATION CONTENT" } };
  await store.reserveWorkspaceOperation(user.id, agent.id, call);
  assert.deepEqual((await makeStore().getWorkspaceOperations(user.id, agent.id))[0].call, call);
  await assert.rejects(store.getWorkspaceOperations(other.id, agent.id), { status: 404 });
  await assert.rejects(store.reserveWorkspaceOperation(user.id, agent.id, { ...call, params: { ...call.params, text: "changed" } }), { status: 409 });
  const spoof = await store.updateWorkspaceOperation(user.id, agent.id, call.request_id, { phase: "succeeded", message: "success", retryable: false });
  assert.equal(spoof.phase, "uncertain"); assert.equal(spoof.result, undefined, "browser hints cannot invent authenticated business results");
  await save("messages.send", { message_id: "stable-message", status: "accepted" }, Date.now(), call.request_id);
  const actual = (await makeStore().getWorkspaceOperations(user.id, agent.id))[0];
  assert.equal(actual.phase, "succeeded"); assert.equal(actual.result.status, "accepted"); assert.deepEqual(actual.call, call);
  await assert.rejects(store.reserveWorkspaceOperation(user.id, agent.id, call), { status: 410 }, "settled calls cannot be recreated after short cache cleanup");
  await store.updateWorkspaceOperation(user.id, agent.id, call.request_id, { phase: "uncertain", retryable: true });
  assert.equal((await store.getWorkspaceOperations(user.id, agent.id))[0].phase, "succeeded", "late browser hints cannot regress an authenticated receipt");
  const dump = JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM "WorkspaceOperation"'));
  assert.equal(dump.includes("PRIVATE OPERATION CONTENT"), false); assert.equal(dump.includes("urn:agent:friend"), false);
  await migrate(db);
  assert.deepEqual((await makeStore().getWorkspaceOperations(user.id, agent.id))[0].call, call, "additive rerun keeps the original call");
}));

test("expired and legacy operations never renew delivery windows or erase an uncertain execute", () => fixture(async ({ db, user, agent, store, makeStore, save }) => {
  const call = { request_id: crypto.randomUUID(), method: "collaboration.execute", params: { action: "invite", task_id: "private-task", recipient_urn: "urn:agent:friend" } };
  await store.reserveWorkspaceOperation(user.id, agent.id, call);
  await save("collaboration.execute", { status: "uncertain", instruction: "Check original operation locally" }, Date.now(), call.request_id);
  let restored = (await makeStore().getWorkspaceOperations(user.id, agent.id))[0];
  assert.equal(restored.phase, "uncertain"); assert.equal(restored.retryable, false); assert.deepEqual(restored.call, call);
  await db.$executeRawUnsafe('UPDATE "WorkspaceOperation" SET "createdAt" = ? WHERE "agentId" = ? AND "requestId" = ?', Date.now() - 130000, agent.id, call.request_id);
  await assert.rejects(store.reserveWorkspaceOperation(user.id, agent.id, call), { status: 410 });
  restored = (await makeStore().getWorkspaceOperations(user.id, agent.id))[0];
  assert.deepEqual(restored.call, call, "expiry retains the original execute forever for audit and verification");
  const old = { request_id: crypto.randomUUID(), method: "contacts.respond", params: { request_id: "friend-request", decision: "accept" } };
  await store.reserveWorkspaceOperation(user.id, agent.id, old, { legacy: true });
  const legacy = (await store.getWorkspaceOperations(user.id, agent.id)).find(item => item.call.request_id === old.request_id);
  assert.equal(legacy.phase, "uncertain"); assert.equal(legacy.retryable, false);
  await assert.rejects(store.reserveWorkspaceOperation(user.id, agent.id, old), { status: 410 }, "legacy browser records have no trusted deadline");
}));

test("authenticated snapshots reconcile exact social operations while reused contacts and executes stay uncertain", () => fixture(async ({ user, agent, store, save }) => {
  const add = reused => ({ request_id: crypto.randomUUID(), method: "contacts.add", params: { contact_id: reused ? "old-contact" : "new-contact", aliases: ["name"], urn: "urn:agent:friend" } });
  const fresh = add(false), reused = add(true), execute = { request_id: crypto.randomUUID(), method: "collaboration.execute", params: { action: "invite", task_id: "task" } };
  await store.reserveWorkspaceOperation(user.id, agent.id, fresh);
  await store.reserveWorkspaceOperation(user.id, agent.id, reused, { reusedContact: true });
  await store.reserveWorkspaceOperation(user.id, agent.id, execute);
  await save("collaboration.state", { contacts: [{ ...fresh.params }, { ...reused.params }], tasks: [{ task_id: "task", status: "active" }] });
  const items = await store.getWorkspaceOperations(user.id, agent.id);
  assert.equal(items.find(item => item.call.request_id === fresh.request_id).phase, "succeeded");
  assert.equal(items.find(item => item.call.request_id === reused.request_id).phase, "sending", "preexisting contact does not prove rejected-request retry ran");
  assert.equal(items.find(item => item.call.request_id === execute.request_id).phase, "sending", "task state cannot prove a specific execute ran");
}));

test("conversation metadata and search preserve encrypted saved history, account isolation, drafts and scroll state", () => fixture(async ({ db, user, other, agent, store, save, makeStore }) => {
  const at = Date.now() - 1000;
  await save("conversation.get", { conversation_id: "chat-one", turns: [{ turn_id: "a", text: "first topic", response: "Historical needle answer", status: "completed", created_at: at / 1000 }] }, at);
  await save("conversation.get", { conversation_id: "chat-two", turns: [{ turn_id: "b", text: "second topic", response: "ordinary answer", status: "completed", created_at: at / 1000 }] }, at + 1);
  await store.selectWorkspaceConversation(user.id, agent.id, "chat-one");
  await store.saveWorkspaceConversationState(user.id, agent.id, "chat-one", { title: "CUSTOM PRIVATE TITLE", archived: true, draft: "DRAFT ONLY SECRET", scrollTop: 321, readAt: Date.now() });
  const current = await makeStore().getWorkspaceAgent(user.id, agent.id);
  assert.equal(current.activeConversationState.draft, "DRAFT ONLY SECRET"); assert.equal(current.activeConversationState.scrollTop, 321);
  assert.equal(current.conversations.find(item => item.id === "chat-one").title, "CUSTOM PRIVATE TITLE");
  assert.deepEqual((await store.listWorkspaceConversations(user.id, agent.id)).items.map(item => item.id), ["chat-two"]);
  const found = await store.listWorkspaceConversations(user.id, agent.id, { q: "NEEDLE", archived: "all" });
  assert.equal(found.scope, "saved_account_history"); assert.equal(found.items[0].id, "chat-one"); assert.equal(found.items[0].match.turnId, "a");
  assert.equal(found.items[0].match.field, "response");
  assert.equal((await store.listWorkspaceConversations(user.id, agent.id, { q: "DRAFT ONLY", archived: "all" })).items.length, 0);
  await assert.rejects(store.listWorkspaceConversations(other.id, agent.id, { q: "needle" }), { status: 404 });
  await assert.rejects(store.saveWorkspaceConversationState(other.id, agent.id, "chat-one", { draft: "bad" }), { status: 404 });
  await assert.rejects(store.saveWorkspaceConversationState(user.id, agent.id, "unknown", { draft: "bad" }), { status: 404 });
  await store.saveWorkspaceConversationState(user.id, agent.id, null, { draft: "new conversation draft", scrollTop: 0 });
  await store.selectWorkspaceConversation(user.id, agent.id, null);
  assert.equal((await makeStore().getWorkspaceAgent(user.id, agent.id)).activeConversationState.draft, "new conversation draft");
  const dump = JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM "WorkspaceConversationState"'));
  assert.equal(dump.includes("CUSTOM PRIVATE TITLE"), false); assert.equal(dump.includes("DRAFT ONLY SECRET"), false);
  await migrate(db);
  assert.equal((await makeStore().listWorkspaceConversations(user.id, agent.id, { archived: "archived" })).items.length, 1);
}));

test("saved conversation pagination is stable at equal times and local unconfirmed text is outside search", () => fixture(async ({ db, user, agent, store, save }) => {
  const at = Date.now() - 1000;
  for (const id of ["a", "b", "c"]) await save("conversation.get", { conversation_id: id, turns: [{ turn_id: id, text: "topic " + id, status: "completed", created_at: at / 1000 }] }, at);
  const first = await store.listWorkspaceConversations(user.id, agent.id, { limit: 2 });
  assert.deepEqual(first.items.map(item => item.id), ["c", "b"]); assert.equal(first.before, "b"); assert.equal(first.hasMore, true);
  assert.deepEqual((await store.listWorkspaceConversations(user.id, agent.id, { before: first.before, limit: 2 })).items.map(item => item.id), ["a"]);
  const call = { request_id: crypto.randomUUID(), method: "conversation.send", params: { text: "UNCONFIRMED PRIVATE PHRASE" } };
  await store.reserveWorkspaceSubmission(user, agent, call);
  await db.$executeRawUnsafe('UPDATE "WorkspaceSubmission" SET "createdAt" = ? WHERE "agentId" = ?', Date.now() - 130000, agent.id);
  await store.dismissWorkspaceSubmission(user.id, agent.id, call.request_id);
  assert.equal((await store.listWorkspaceConversations(user.id, agent.id, { q: "UNCONFIRMED PRIVATE" })).items.length, 0);
}));

test("conversation result notifications use actual terminal facts, deduplicate native feed and keep decisions separate from read state", () => fixture(async ({ user, agent, store, save }) => {
  const at = Date.now() - 1000;
  await save("conversation.get", { conversation_id: "chat", turns: [{ turn_id: "old", text: "old", status: "completed", created_at: (at - 10000) / 1000 }] }, at);
  assert.equal((await store.getWorkspaceNotifications(user.id)).items[0].systemEligible, false, "first history import cannot trigger result popups");
  await save("conversation.get", { conversation_id: "chat", turns: [{ turn_id: "new", text: "new", status: "running", created_at: at / 1000 }] }, at + 1);
  await save("conversation.get", { conversation_id: "chat", turns: [{ turn_id: "new", status: "completed", response: "private reply", updated_at: (at + 100) / 1000 }] }, at + 101);
  let page = await store.getWorkspaceNotifications(user.id);
  const result = page.items.find(item => item.target.turn_id === "new");
  assert.equal(result.kind, "conversation_completed"); assert.equal(result.systemEligible, true); assert.equal(result.requiresAction, false);
  assert.match(result.href, /conversation=chat/); assert.match(result.href, /turn=new/);
  await save("collaboration.state", { pending_confirmations: [{ approval_id: "approval", kind: "task", subject_id: "task", status: "pending", question: "confirm?" }] }, at + 102);
  await store.saveWorkspaceConversationState(user.id, agent.id, "chat", { readAt: Date.now() });
  page = await store.getWorkspaceNotifications(user.id);
  assert.equal(page.items.find(item => item.target.turn_id === "new").unread, false); assert.equal(page.pending, 1, "reading a chat cannot approve or remove its business decision");
  await save("attention.list", attentionPage([attentionItem({ attention_id: "native-conversation", subject_id: "new", kind: "conversation_completed", target: { kind: "conversation", id: "chat", turn_id: "new" }, source_revision: "complete", created_at: at / 1000, updated_at: (at + 100) / 1000 })], 1), at + 103);
  page = await store.getWorkspaceNotifications(user.id);
  assert.equal(page.items.filter(item => item.target.kind === "conversation" && item.target.turn_id === "new").length, 1);
  assert.equal(page.items.find(item => item.target.turn_id === "new").unread, false, "native projection retains an already-read local result");
  await save("conversation.get", { conversation_id: "chat", turns: [{ turn_id: "failed", status: "failed", error: "private failure", updated_at: Date.now() / 1000 }] }, at + 104);
  assert.equal((await store.getWorkspaceNotifications(user.id)).items.find(item => item.target.turn_id === "failed").kind, "conversation_failed");
}));


test("background reads do not invent unread conversation activity but a later reply does", () => fixture(async ({ user, agent, store, save }) => {
  const at = Date.now() - 10000;
  await save("conversation.get", { conversation_id: "stable", turns: [{ turn_id: "turn", text: "hello", status: "running", created_at: at / 1000 }] }, at);
  await store.saveWorkspaceConversationState(user.id, agent.id, "stable", { readAt: at + 10 });
  const unchanged = { conversation_id: "stable", turns: [{ turn_id: "turn", text: "hello", status: "running", created_at: at / 1000 }] };
  await save("conversation.get", unchanged, at + 100);
  assert.equal((await store.listWorkspaceConversations(user.id, agent.id)).items[0].unread, false);
  assert.equal((await store.listWorkspaceConversations(user.id, agent.id)).items[0].updatedAt, at);
  await save("conversation.get", { conversation_id: "stable", turns: [{ turn_id: "turn", text: "hello", response: "actual reply", status: "completed", created_at: at / 1000 }] }, at + 200);
  assert.equal((await store.listWorkspaceConversations(user.id, agent.id)).items[0].unread, true);
  assert.equal((await store.listWorkspaceConversations(user.id, agent.id)).items[0].updatedAt, at + 200);
  await store.saveWorkspaceConversationState(user.id, agent.id, "stable", { readAt: at + 210 });
  await save("conversation.get", { conversation_id: "stable", turns: [{ turn_id: "turn", text: "hello", response: "actual reply", status: "completed", created_at: at / 1000 }] }, at + 300);
  assert.equal((await store.listWorkspaceConversations(user.id, agent.id)).items[0].unread, false);
}));


test("old-host interrupted terminal turns produce a safe uncertain-result notification without resending", () => fixture(async ({ user, agent, store, save }) => {
  const at = Date.now() - 1000;
  await save("conversation.get", { conversation_id: "interrupted-chat", turns: [{ turn_id: "turn", text: "original request", status: "running", created_at: at / 1000 }] }, at);
  await save("conversation.get", { conversation_id: "interrupted-chat", turns: [{ turn_id: "turn", status: "interrupted", error: "host restarted", updated_at: (at + 100) / 1000 }] }, at + 101);
  const page = await store.getWorkspaceNotifications(user.id), item = page.items.find(item => item.target.turn_id === "turn");
  assert.equal(item.kind, "conversation_failed"); assert.equal(item.systemEligible, true); assert.equal(item.requiresAction, false);
  assert.match(item.summary, /尚不确定/); assert.match(item.summary, /不会自动重新发送/);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id, "interrupted-chat")).conversation.turns[0].text, "original request");
  await save("conversation.get", { conversation_id: "interrupted-chat", turns: [{ turn_id: "local-only", status: "interrupted", locally_unconfirmed: true }] }, at + 102);
  assert.equal((await store.getWorkspaceNotifications(user.id)).items.some(item => item.target.turn_id === "local-only"), false, "unconfirmed local hints cannot create an authenticated terminal reminder");
}));

test("description reads do not enter the business ledger and old description audits cannot hide unknown writes", () => fixture(async ({ db, user, agent, store }) => {
 const describe={request_id:crypto.randomUUID(),method:"collaboration.execute",params:{action:"describe"}};
 assert.equal(await store.reserveWorkspaceOperation(user.id,agent.id,describe),null);
 assert.equal((await db.$queryRawUnsafe('SELECT COUNT(*) as n FROM "WorkspaceOperation"'))[0].n,0n);
 const createdAt=Date.now()-120001,legacy={call:describe,phase:"uncertain",retryable:false,message:"old read",createdAt,updatedAt:createdAt};
 const key=crypto.createHmac("sha256","isolated-workspace-fixture-secret").update("agent-workspace/storage/v1").digest(),nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv("aes-256-gcm",key,nonce);
 cipher.setAAD(Buffer.from(JSON.stringify([user.id,agent.id,"operation",describe.request_id])));
 const bytes=Buffer.concat([cipher.update(JSON.stringify(legacy),"utf8"),cipher.final()]);
 const payload=["v1",nonce.toString("base64"),cipher.getAuthTag().toString("base64"),bytes.toString("base64")].join(".");
 await db.$executeRawUnsafe('INSERT INTO "WorkspaceOperation" ("agentId","requestId","method","phase","payload","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)',agent.id,describe.request_id,describe.method,"uncertain",payload,createdAt,createdAt);
 const write={request_id:crypto.randomUUID(),method:"collaboration.execute",params:{action:"prepare_task",task_id:"original-task"}};
 await store.reserveWorkspaceOperation(user.id,agent.id,write);await store.updateWorkspaceOperation(user.id,agent.id,write.request_id,{phase:"uncertain",retryable:false});
 const restored=await store.getWorkspaceOperations(user.id,agent.id);
 assert.equal(restored.length,1);assert.deepEqual(restored[0].call,write);assert.equal(restored[0].phase,"uncertain");
 assert.equal((await db.$queryRawUnsafe('SELECT COUNT(*) as n FROM "WorkspaceOperation"'))[0].n,2n,"old read audit remains stored");
}));


test("deleted chats retain encrypted history, survive sync and delayed metadata saves, and require explicit restoration", () => fixture(async ({ db, user, other, agent, store, save }) => {
  await save("conversation.get", { conversation_id: "old-chat", turns: [{ turn_id: "old-turn", text: "private history", response: "private answer", status: "completed" }] });
  await store.selectWorkspaceConversation(user.id, agent.id, "old-chat");
  await store.saveWorkspaceConversationState(user.id, agent.id, "old-chat", { title: "My private title", archived: true, draft: "saved draft" });
  const deleted = await store.saveWorkspaceConversationState(user.id, agent.id, "old-chat", { deleted: true });
  assert.equal(deleted.deleted, true);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).activeConversationId, "");
  assert.equal((await store.listWorkspaceConversations(user.id, agent.id, { archived: "all" })).items.length, 0);
  assert.equal((await store.listWorkspaceConversations(user.id, agent.id, { deleted: "deleted" })).items[0].title, "My private title");
  await store.saveWorkspaceConversationState(user.id, agent.id, "old-chat", { draft: "late saved draft", readAt: Date.now() });
  await save("conversation.get", { conversation_id: "old-chat", turns: [{ turn_id: "new-turn", text: "later remote history", status: "completed" }] }, Date.now() + 100);
  const restoredStore = (await store.getWorkspaceAgent(user.id, agent.id, "old-chat"));
  assert.equal(restoredStore.activeConversationId, "old-chat", "deleted reads remain bound to their requested ID even after account selection clears");
  assert.equal(restoredStore.activeConversationState.deleted, true);
  assert.equal(restoredStore.conversation, null); assert.equal(restoredStore.snapshots["conversation.get"], undefined);
  assert.equal((await store.listWorkspaceConversations(user.id, agent.id, { q: "later remote", archived: "all" })).items.length, 0);
  await assert.rejects(store.selectWorkspaceConversation(user.id, agent.id, "old-chat"), { status: 409 });
  await assert.rejects(store.reserveWorkspaceSubmission(user, agent, { request_id: crypto.randomUUID(), method: "conversation.send", params: { conversation_id: "old-chat", text: "never send hidden" } }), { status: 409 });
  await assert.rejects(store.saveWorkspaceConversationState(other.id, agent.id, "old-chat", { deleted: false }), { status: 404 });
  await store.saveWorkspaceConversationState(user.id, agent.id, "old-chat", { deleted: false });
  await store.selectWorkspaceConversation(user.id, agent.id, "old-chat");
  const visible = await store.getWorkspaceAgent(user.id, agent.id, "old-chat");
  assert.equal(visible.conversation.turns.length, 2); assert.equal(visible.activeConversationState.draft, "late saved draft");
  const dump = JSON.stringify(await db.$queryRawUnsafe('SELECT "payload" FROM "WorkspaceConversationState"'));
  assert.doesNotMatch(dump, /My private title|late saved draft/);
}));

test("deletion cannot hide running turns, uncertain submissions, or unsettled business writes", () => fixture(async ({ user, agent, store, save }) => {
  await save("conversation.get", { conversation_id: "processing", turns: [{ turn_id: "working", status: "running", text: "work" }] });
  await assert.rejects(store.saveWorkspaceConversationState(user.id, agent.id, "processing", { deleted: true }), { status: 409 });
  await assert.rejects(store.removeWorkspaceAgent(user.id, agent.id), { status: 409 });
  await save("conversation.get", { conversation_id: "processing", turns: [{ turn_id: "working", status: "completed", response: "done" }] }, Date.now() + 1);
  const send = { request_id: crypto.randomUUID(), method: "conversation.send", params: { conversation_id: "processing", text: "unknown" } };
  await store.reserveWorkspaceSubmission(user, agent, send); await store.markWorkspaceSubmissionUncertain(agent.id, send.request_id);
  await assert.rejects(store.saveWorkspaceConversationState(user.id, agent.id, "processing", { deleted: true }), { status: 409 });
  await assert.rejects(store.removeWorkspaceAgent(user.id, agent.id), { status: 409 });
  await store.clearWorkspaceSubmission(agent.id, send.request_id);
  const action = { request_id: crypto.randomUUID(), method: "collaboration.execute", params: { action: "prepare_task", task_id: "unknown-action" } };
  await store.reserveWorkspaceOperation(user.id, agent.id, action); await store.updateWorkspaceOperation(user.id, agent.id, action.request_id, { phase: "uncertain", retryable: false });
  await assert.rejects(store.saveWorkspaceConversationState(user.id, agent.id, "processing", { deleted: true }), { status: 409 });
  await assert.rejects(store.removeWorkspaceAgent(user.id, agent.id), { status: 409 });
  assert.equal((await store.getWorkspaceOperations(user.id, agent.id))[0].call.request_id, action.request_id);
}));

test("contact view deletion is account scoped, blocks pending relationships and survives authenticated refreshes", () => fixture(async ({ db, user, other, agent, store, save, makeStore }) => {
  const contact = { contact_id: "friend", aliases: ["Private friend name"], urn: "urn:agent:friend", connection_status: "connected" };
  await save("contacts.list", { contacts: [contact] });
  const state = await store.saveWorkspaceRecordState(user.id, agent.id, "contact", "friend", true);
  assert.equal(state.deleted, true); assert.equal(state.title, "Private friend name");
  await save("contacts.list", { contacts: [{ ...contact, last_presence_at: Date.now() / 1000 }] }, Date.now() + 100);
  assert.equal((await makeStore().getWorkspaceAgent(user.id, agent.id)).recordStates[0].deleted, true);
  assert.equal((await store.getWorkspaceAgent(user.id, agent.id)).snapshots["contacts.list"].data.contacts[0].contact_id, "friend", "authenticated agent facts are retained");
  await assert.rejects(store.getWorkspaceRecordStates(other.id, agent.id), { status: 404 });
  await assert.rejects(store.saveWorkspaceRecordState(other.id, agent.id, "contact", "friend", false), { status: 404 });
  await assert.rejects(store.reserveWorkspaceOperation(user.id, agent.id, { request_id: crypto.randomUUID(), method: "messages.send", params: { recipient_urn: contact.urn, text: "hidden target" } }), { status: 409 });
  assert.doesNotMatch(JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM "WorkspaceRecordState"')), /Private friend name/);
  await save("contacts.list", { contacts: [] }, Date.now() + 200);
  const restored = await store.saveWorkspaceRecordState(user.id, agent.id, "contact", "friend", false);
  assert.equal(restored.title, "Private friend name"); assert.equal(restored.deleted, false);
  await save("contacts.list", { contacts: [{ ...contact, connection_status: "pending" }] }, Date.now() + 300);
  await assert.rejects(store.saveWorkspaceRecordState(user.id, agent.id, "contact", "friend", true), { status: 409 });
}));

test("collaboration aliases share one recoverable tombstone and cannot hide live or unconfirmed completion", () => fixture(async ({ user, agent, store, save }) => {
  const task = { task_id: "task-view", status: "active", scope: { topic: "Private cooperation title" } };
  const collaboration = { task_id: "task-view", collaboration_id: "collab-view", phase: "closed", closure_reason: "agreement_only_complete", agreement_synced: false };
  await save("collaboration.state", { tasks: [task], collaborations: [collaboration] });
  await assert.rejects(store.saveWorkspaceRecordState(user.id, agent.id, "collaboration", "collab-view", true), { status: 409 });
  await save("collaboration.state", { tasks: [task], collaborations: [{ ...collaboration, agreement_synced: true }], pending_confirmations: [{ approval_id: "approval", subject_id: task.task_id, status: "pending" }] }, Date.now() + 100);
  await assert.rejects(store.saveWorkspaceRecordState(user.id, agent.id, "collaboration", "task-view", true), { status: 409 });
  await save("collaboration.state", { tasks: [task], collaborations: [{ ...collaboration, agreement_synced: true }], pending_confirmations: [] }, Date.now() + 200);
  const state = await store.saveWorkspaceRecordState(user.id, agent.id, "collaboration", "collab-view", true);
  assert.equal(state.id, "task-view"); assert.deepEqual(new Set(state.relatedIds), new Set(["task-view", "collab-view"]));
  assert.equal((await store.getWorkspaceRecordStates(user.id, agent.id)).length, 1);
  await save("collaboration.state", { tasks: [], collaborations: [] }, Date.now() + 300);
  const restored = await store.saveWorkspaceRecordState(user.id, agent.id, "collaboration", "collab-view", false);
  assert.equal(restored.id, "task-view"); assert.equal(restored.deleted, false); assert.equal(restored.title, "Private cooperation title");
  await assert.rejects(store.saveWorkspaceRecordState(user.id, agent.id, "collaboration", "missing", true), { status: 404 });
}));

test("connection rename and removal isolate shared URNs, cascade Web records and preserve other account identity", () => fixture(async ({ db, user, other, agent, otherAgent, store, save }) => {
  await save("contacts.list", { contacts: [{ contact_id: "friend", aliases: ["friend"], connection_status: "connected" }] });
  await store.saveWorkspaceRecordState(user.id, agent.id, "contact", "friend", true);
  await save("conversation.get", { conversation_id: "closed", turns: [{ turn_id: "turn", text: "private", status: "completed" }] });
  await store.saveWorkspaceConversationState(user.id, agent.id, "closed", { deleted: true });
  const identity = await db.user.findUnique({ where: { id: user.id } });
  await assert.rejects(store.renameWorkspaceAgent(other.id, agent.id, "attack"), { status: 404 });
  await assert.rejects(store.removeWorkspaceAgent(other.id, agent.id), { status: 404 });
  assert.deepEqual(await store.renameWorkspaceAgent(user.id, agent.id, "My renamed agent"), { id: agent.id, name: "My renamed agent" });
  await store.removeWorkspaceAgent(user.id, agent.id);
  assert.equal(await store.getWorkspaceAgent(user.id, agent.id), null);
  assert.equal((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceRecordState"'))[0].n, 0n);
  assert.equal((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceItem" WHERE "agentId" = ?', agent.id))[0].n, 0n);
  assert.equal((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceConversationState"'))[0].n, 0n);
  assert.equal((await store.getWorkspaceAgent(other.id, otherAgent.id)).agent.urn, agent.urn);
  assert.deepEqual(await db.user.findUnique({ where: { id: user.id } }), identity);
}));
