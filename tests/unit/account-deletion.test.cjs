const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");
const { PrismaClient } = require("@prisma/client");
const { migrateAccountEmail } = require("../../scripts/migrate-account-email.cjs");

function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return loaded.exports;
}
const passwords = load("../../src/lib/auth/password.ts");
const email = load("../../src/lib/auth/account-email.ts", { "@/lib/shared/db": { prisma: {} }, "./password": passwords });
const deletion = load("../../src/lib/auth/account-deletion.ts", { "@/lib/shared/db": { prisma: {} }, "./password": passwords, "./account-email": email });
const client = load("../../src/lib/auth/account-deletion-client.ts");
const digest = value => crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
const quoted = name => '"' + name.replaceAll('"', '""') + '"';
const AGENT_TABLES = ["WorkspacePeerSafety", "ControlRequest", "WorkspaceState", "WorkspaceSnapshot", "WorkspaceItem", "WorkspaceConversation", "WorkspaceSubmission", "WorkspaceOperation", "WorkspaceConversationState", "WorkspaceRecordState", "WorkspaceNotification", "WorkspaceNotificationBaseline", "WorkspaceNotificationDelivery"];
const USER_TABLES = ["ModerationReport", "ModerationContent", "ModerationRate", "ManagedConsoleCertificate", "UserPolicyConsent", "UserControlPause", "EmailActionToken", "OnboardingTicket", "WebPushSubscription"];
const LEGACY = ["Contact", "Message", "HITLRequest", "Transaction"];
test("confirmed deletion clears only this browser account's report recovery and notification records",()=>{
 const values=new Map([["content-report:v1:own%3Aer:agent:inbox:one","private evidence"],["content-report:v1:own%3Aer:agent:turn:two","pending original report"],["content-report:v1:own%3Aer-other:agent:turn:three","another account report"],["agent-notifications:v1:own:er","own notifications"],["agent-notifications:v1:other","other notifications"],["ordinary-preference","preserve"]]);
 const storage={get length(){return values.size;},key(index){return [...values.keys()][index] || null;},removeItem(key){values.delete(key);}};
 client.clearDeletedAccountLocalRecords("own:er",storage);assert.deepEqual([...values.keys()],["content-report:v1:own%3Aer-other:agent:turn:three","agent-notifications:v1:other","ordinary-preference"]);
 assert.throws(()=>client.clearDeletedAccountLocalRecords("owner",{get length(){throw new Error("browser storage denied");}}),/storage denied/);
});

async function fixture(run, { legacyWithoutForeignKeys = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-account-delete-")), filename = path.join(directory, "test.db");
  const db = new PrismaClient({ datasources: { db: { url: "file:" + filename + "?connection_limit=1" } } });
  try {
    if (legacyWithoutForeignKeys) {
      await db.$executeRawUnsafe('CREATE TABLE "Agent" ("id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "name" TEXT NOT NULL, "urn" TEXT NOT NULL, "publicKey" TEXT NOT NULL, "platformRegistered" BOOLEAN NOT NULL DEFAULT false, "lastActiveAt" DATETIME, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL)');
      await db.$executeRawUnsafe('CREATE TABLE "WorkspaceSnapshot" ("agentId" TEXT NOT NULL, "method" TEXT NOT NULL, "recordKey" TEXT NOT NULL DEFAULT \'\', "payload" TEXT NOT NULL, "sourceAt" REAL NOT NULL, "savedAt" REAL NOT NULL, "requestId" TEXT NOT NULL, PRIMARY KEY("agentId","method","recordKey"))');
      await db.$executeRawUnsafe('CREATE TABLE "WorkspaceState" ("agentId" TEXT PRIMARY KEY,"activeConversationId" TEXT NOT NULL DEFAULT \'\',"activeSelectedAt" REAL NOT NULL DEFAULT 0,"status" TEXT NOT NULL DEFAULT \'waiting\',"lastAttemptAt" REAL,"lastSuccessAt" REAL,"nextSyncAt" REAL NOT NULL DEFAULT 0,"error" TEXT,"failures" INTEGER NOT NULL DEFAULT 0,"requestId" TEXT,"plan" TEXT,"leaseToken" TEXT,"leaseUntil" REAL,"lastWakeAt" REAL NOT NULL DEFAULT 0)');
    }
    const migration = fs.readFileSync(path.resolve(__dirname, "../../prisma/remote-console.sql"), "utf8");
    for (const statement of migration.replace(/^\s*--.*$/gm, "").split(";").filter(sql => sql.trim())) await db.$executeRawUnsafe(statement);
    await migrateAccountEmail(db);
    assert.equal(Number((await db.$queryRawUnsafe("PRAGMA foreign_keys"))[0].foreign_keys), 1);
    const password = "synthetic-current-password", passwordHash = await passwords.hashPassword(password);
    const owner = await db.user.create({ data: { id: "owner", email: "Owner@example.invalid", passwordHash, virtualUrn: "urn:console:owner" } });
    const other = await db.user.create({ data: { id: "other", email: "other@example.invalid", passwordHash, virtualUrn: "urn:console:other" } });
    const ownerAgent = await db.agent.create({ data: { id: "owner-agent", userId: owner.id, name: "Owner agent", urn: "urn:agent:shared", publicKey: "synthetic-key" } });
    const otherAgent = await db.agent.create({ data: { id: "other-agent", userId: other.id, name: "Other agent", urn: "urn:agent:shared", publicKey: "synthetic-key" } });
    const context = { db, owner, other, ownerAgent, otherAgent, password, service: deletion.createAccountDeletionService({ db }) };
    await run(context);
  } finally {
    await db.$disconnect();
    for (const suffix of ["", "-journal", "-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.unlinkSync(filename + suffix);
    fs.rmdirSync(directory);
  }
}

async function seed(db, table, user, agent, overrides = {}) {
  const info = await db.$queryRawUnsafe(`PRAGMA table_info(${quoted(table)})`);
  const fields = info.filter(column => column.dflt_value === null && column.name !== "seq");
  const value = column => {
    if (Object.hasOwn(overrides, column.name)) return overrides[column.name];
    if (column.name === "userId") return user.id;
    if (column.name === "agentId") return agent.id;
    if (column.name === "subscriptionId") return "subscription-" + user.id;
    if (column.name === "notificationId") return "notice-" + user.id;
    if (column.name === "id" && table === "WebPushSubscription") return "subscription-" + user.id;
    if (column.name === "id" && table === "WorkspaceNotification") return "notice-" + user.id;
    if (column.name === "recipientHash") return digest(user.email);
    if (/INT|REAL|FLOAT/i.test(column.type)) return 1;
    if (/DATE/i.test(column.type)) return new Date().toISOString();
    return column.name + "-" + user.id;
  };
  await db.$executeRawUnsafe(`INSERT INTO ${quoted(table)} (${fields.map(column => quoted(column.name)).join(",")}) VALUES (${fields.map(() => "?").join(",")})`, ...fields.map(value));
}

test("transaction removes every current account-owned table and preserves another account plus global state", () => fixture(async context => {
  const { db, owner, other, ownerAgent, otherAgent, password, service } = context;
  for (const table of [...USER_TABLES, ...AGENT_TABLES, "WebPushDelivery", "AuthEmailSend"]) {
    await seed(db, table, owner, ownerAgent); await seed(db, table, other, otherAgent);
  }
  await db.$executeRawUnsafe('INSERT INTO "PlatformPolicyState" VALUES (\'platform-global\',1,\'policy\')');
  await db.$executeRawUnsafe('INSERT INTO "WebPushConfig" VALUES (\'global-keys\',\'private-global-config\',1)');
  await db.authEmailBudget.create({ data: { day: "2026-09-27", used: 2 } });
  const all = await db.$queryRawUnsafe('SELECT "name" FROM "sqlite_master" WHERE "type"=\'table\' AND "name" NOT LIKE \'sqlite_%\'');
  const before = Object.fromEntries(await Promise.all(all.map(async ({ name }) => [name, await db.$queryRawUnsafe(`SELECT * FROM ${quoted(name)}`)])));
  for (const table of [...USER_TABLES, ...AGENT_TABLES, "WebPushDelivery"]) {
    const foreignKeys = await db.$queryRawUnsafe(`PRAGMA foreign_key_list(${quoted(table)})`);
    assert.ok(foreignKeys.length, table + " must have real ownership foreign keys on new databases");
    assert.ok(foreignKeys.every(key => key.on_delete === "CASCADE"), table + " must cascade on a new install");
  }
  assert.deepEqual(await service.deleteAccount(owner.id, password, 0), { deleted: true, consoleUrn: owner.virtualUrn, message: "账户及本工作区保存的账户数据已删除。其他设备的登录会话已失效。" });
  for (const table of [...USER_TABLES, ...AGENT_TABLES, "WebPushDelivery", "AuthEmailSend", "Agent", "User"]) {
    const after = await db.$queryRawUnsafe(`SELECT * FROM ${quoted(table)}`);
    assert.equal(after.length, 1, table + " must retain only the other account");
    assert.deepEqual(after, before[table].filter(row => !JSON.stringify(row, (_, value) => typeof value === "bigint" ? value.toString() : value).includes("owner") && row.recipientHash !== digest(owner.email)), table + " must not change another account");
  }
  for (const table of ["PlatformPolicyState", "WebPushConfig", "AuthEmailBudget", "WorkspaceNotificationSequence"]) assert.deepEqual(await db.$queryRawUnsafe(`SELECT * FROM ${quoted(table)}`), before[table]);
  assert.deepEqual(await db.$queryRawUnsafe("PRAGMA foreign_key_check"), []);
}));

test("legacy tables without cascade and orphan messages are cleaned by exact account scope", () => fixture(async ({ db, owner, other, ownerAgent, otherAgent, password, service }) => {
  for (const table of LEGACY) {
    await db.$executeRawUnsafe(`CREATE TABLE ${quoted(table)} ("id" TEXT PRIMARY KEY,"userId" TEXT NOT NULL,"agentId" TEXT NOT NULL,"payload" TEXT NOT NULL)`);
    await seed(db, table, owner, ownerAgent); await seed(db, table, other, otherAgent);
  }
  await db.$executeRawUnsafe('INSERT INTO "Message" VALUES (\'orphan-message\',\'owner\',\'missing-legacy-agent\',\'private old message\')');
  await seed(db, "WorkspaceSnapshot", owner, ownerAgent); await seed(db, "WorkspaceSnapshot", other, otherAgent);
  await service.deleteAccount(owner.id, password, 0);
  for (const table of [...LEGACY, "WorkspaceSnapshot", "Agent"]) {
    const rows = await db.$queryRawUnsafe(`SELECT * FROM ${quoted(table)}`); assert.equal(rows.length, 1); assert.ok(JSON.stringify(rows).includes("other"));
  }
}, { legacyWithoutForeignKeys: true }));

test("wrong password, stale session and a password/version change during verification never delete", () => fixture(async ({ db, owner, password, service }) => {
  await assert.rejects(service.deleteAccount(owner.id, "wrong-password", 0), error => error.code === "INVALID_PASSWORD");
  await assert.rejects(service.deleteAccount(owner.id, password, 1), error => error.code === "ACCOUNT_CHANGED");
  const raced = deletion.createAccountDeletionService({ db, verify: async (...args) => {
    const verified = await passwords.verifyPassword(...args);
    await db.user.update({ where: { id: owner.id }, data: { passwordHash: await passwords.hashPassword("new-synthetic-password"), sessionVersion: { increment: 1 } } });
    return verified;
  } });
  await assert.rejects(raced.deleteAccount(owner.id, password, 0), error => error.code === "ACCOUNT_CHANGED");
  assert.equal((await db.user.findUnique({ where: { id: owner.id } })).sessionVersion, 1);
  assert.equal(await db.agent.count({ where: { userId: owner.id } }), 1);
}));

test("late synchronization cannot recreate legacy workspace rows after deletion commits between probe and transaction", () => fixture(async ({ db, owner, ownerAgent, password, service }) => {
  const ControlError = class extends Error { constructor(message, status) { super(message); this.status = status; } };
  let entered = false;
  const delayed = new Proxy(db, { get(target, property) {
    if (property === "$transaction") return async (...args) => {
      if (!entered) { entered = true; await service.deleteAccount(owner.id, password, 0); }
      return target.$transaction(...args);
    };
    const value = Reflect.get(target, property, target); return typeof value === "function" ? value.bind(target) : value;
  } });
  const store = load("../../src/lib/workspace/workspace-store.ts", { "@/lib/shared/db": { prisma: delayed }, "@/lib/control/control-transport": { ControlError }, "@/lib/moderation/inbound": {filterWorkspaceInbound:async(_db,_user,_agent,_urn,_method,data)=>data}, "@/lib/control/workbench-client": load("../../src/lib/control/workbench-client.ts") });
  const row = { id: "late-sync-request", agentId: ownerAgent.id, method: "capabilities", createdAt: new Date() };
  await assert.rejects(store.recordWorkspaceResponse(owner, ownerAgent, row, { result: { methods: [] } }), error => error.status === 404);
  assert.ok(entered, "deletion occurs after the outer owned check");
  assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceState" WHERE "agentId"=?', ownerAgent.id))[0].n), 0);
  assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceSnapshot" WHERE "agentId"=?', ownerAgent.id))[0].n), 0);
}, { legacyWithoutForeignKeys: true }));

test("unrecognized account archive safely rolls back every deletion and session increment", () => fixture(async ({ db, owner, password, service }) => {
  await db.$executeRawUnsafe('CREATE TABLE "UnrecognizedArchive" ("id" TEXT,"owner" TEXT,FOREIGN KEY("owner") REFERENCES "User"("id"))');
  await db.$executeRawUnsafe('INSERT INTO "UnrecognizedArchive" VALUES (\'private-archive\',\'owner\')');
  await assert.rejects(service.deleteAccount(owner.id, password, 0), error => error.code === "DELETE_SCHEMA_UNSUPPORTED");
  assert.equal((await db.user.findUnique({ where: { id: owner.id } })).sessionVersion, 0);
  assert.equal(await db.agent.count(), 2);
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "UnrecognizedArchive"')).length, 1);
}));

test("simultaneous valid deletion requests commit once and the competing generation is rejected", () => fixture(async ({ db, owner, password }) => {
  let arrivals = 0, release;
  const barrier = new Promise(resolve => { release = resolve; });
  const service = deletion.createAccountDeletionService({ db, verify: async (...args) => {
    const verified = await passwords.verifyPassword(...args);
    if (++arrivals === 2) release();
    await barrier; return verified;
  } });
  const results = await Promise.allSettled([service.deleteAccount(owner.id, password, 0), service.deleteAccount(owner.id, password, 0)]);
  assert.equal(results.filter(result => result.status === "fulfilled" && result.value.deleted === true).length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason.code === "ACCOUNT_CHANGED").length, 1);
  assert.equal(await db.user.count(), 1); assert.equal(await db.agent.count(), 1);
}));

test("a final database delete failure rolls back already-cleaned records and the session fence", () => fixture(async ({ db, owner, ownerAgent, password, service }) => {
  await seed(db, "WorkspaceSnapshot", owner, ownerAgent);
  await seed(db, "EmailActionToken", owner, ownerAgent);
  await seed(db, "AuthEmailSend", owner, ownerAgent);
  await db.$executeRawUnsafe('CREATE TRIGGER "refuse_owner_delete" BEFORE DELETE ON "User" WHEN OLD."id"=\'owner\' BEGIN SELECT RAISE(ABORT,\'synthetic deletion failure\'); END');
  await assert.rejects(service.deleteAccount(owner.id, password, 0));
  assert.equal((await db.user.findUnique({ where: { id: owner.id } })).sessionVersion, 0);
  assert.equal(await db.agent.count({ where: { userId: owner.id } }), 1);
  assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceSnapshot"'))[0].n), 1);
  assert.equal(await db.emailActionToken.count(), 1); assert.equal(await db.authEmailSend.count(), 1);
}));

test("case-variant legacy accounts cannot lose their shared email digest logs", () => fixture(async ({ db, owner, other, password, service }) => {
  await db.user.update({ where: { id: other.id }, data: { email: "owner@example.invalid" } });
  await db.authEmailSend.create({ data: { id: "shared-log", recipientHash: digest(owner.email), purpose: "verify-email", createdAt: Date.now(), status: "accepted" } });
  await service.deleteAccount(owner.id, password, 0);
  assert.equal(await db.authEmailSend.count(), 1); assert.ok(await db.user.findUnique({ where: { id: other.id } }));
}));

test("delayed email-provider acceptance cannot recreate tokens or recipient logs after deletion", () => fixture(async ({ db, owner, password, service }) => {
  let release, arrived;
  const reached = new Promise(resolve => { arrived = resolve; });
  const provider = new Promise(resolve => { release = resolve; });
  const mailer = email.createAccountEmailService({ db, env: { NEXTAUTH_URL: "https://console.example.invalid", RESEND_API_KEY: "synthetic-key", AUTH_EMAIL_FROM: "accounts@example.invalid" }, fetch: async () => { arrived(); await provider; return Response.json({ id: "synthetic-acceptance" }); } });
  const pending = mailer.resendVerification(owner.email).then(value => ({ value }), error => ({ error }));
  await reached;
  assert.equal(await db.emailActionToken.count(), 1);
  await service.deleteAccount(owner.id, password, 0);
  release(); await pending;
  assert.equal(await db.emailActionToken.count(), 0); assert.equal(await db.authEmailSend.count(), 0);
}));

test("deleted users revoke both current and historical sessions on the next server check", () => fixture(async ({ db, owner, password, service }) => {
  const auth = load("../../src/lib/auth/auth.ts", { "@/lib/shared/db": { prisma: db }, "./password": passwords }).authOptions;
  const token = { id: owner.id, sessionVersion: 0 };
  assert.equal((await auth.callbacks.jwt({ token })).id, owner.id);
  const session = await auth.callbacks.session({ session: { user: {} }, token }); assert.equal(session.user.sessionVersion, 0);
  await service.deleteAccount(owner.id, password, 0);
  assert.deepEqual(await auth.callbacks.jwt({ token }), { sessionRevoked: true });
  assert.deepEqual(await auth.callbacks.jwt({ token: { id: owner.id } }), { sessionRevoked: true });
}));

test("deletion route rejects CSRF, invalid confirmation, oversized body and unauthenticated callers", async () => {
  const previous = process.env.NEXTAUTH_URL; process.env.NEXTAUTH_URL = "https://console.example.invalid";
  let session = { user: { id: "owner", sessionVersion: 7 } }; const calls = [];
  const helper = load("../../src/lib/auth/account-email-http.ts", { "./password": passwords, "./account-email": email, "@/lib/shared/http-input": load("../../src/lib/shared/http-input.ts"), "./auth": { authOptions: {} }, "next-auth": { getServerSession: async () => session } });
  const route = load("../../src/app/api/auth/delete-account/route.ts", { "@/lib/auth/account-deletion": { accountDeletionService: { deleteAccount: async (...args) => { calls.push(args); return { deleted: true }; } } }, "@/lib/auth/account-email-http": helper, "@/lib/auth/account-email": email, "@/lib/auth/password": passwords });
  const body = { currentPassword: "synthetic-current-password", confirmation: "DELETE", expectedAccountId: "owner" };
  const request = (payload = body, headers = {}) => new Request("https://untrusted-host.invalid/api/auth/delete-account", { method: "POST", headers: { origin: process.env.NEXTAUTH_URL, ...headers }, body: typeof payload === "string" ? payload : JSON.stringify(payload) });
  try {
    assert.equal(route.GET, undefined); assert.equal(route.DELETE, undefined);
    assert.equal((await route.POST(request(body, { origin: "https://evil.invalid" }))).status, 403);
    assert.equal((await route.POST(request(body, { "sec-fetch-site": "cross-site" }))).status, 403);
    assert.equal((await route.POST(request({ ...body, confirmation: "delete" }))).status, 400);
    const { expectedAccountId, ...missingIdentity } = body;
    assert.equal((await route.POST(request(missingIdentity))).status, 400);
    const changedAccount = await route.POST(request({ ...body, expectedAccountId: "other" }));
    assert.equal(changedAccount.status, 409); assert.equal((await changedAccount.json()).code, "ACCOUNT_CHANGED");
    assert.equal((await route.POST(request({ ...body, userId: "other" }))).status, 400);
    assert.equal((await route.POST(request("x".repeat(16385)))).status, 413);
    session = null; assert.equal((await route.POST(request())).status, 401);
    session = { user: { id: "owner" } }; assert.equal((await route.POST(request())).status, 401);
    assert.equal(calls.length, 0);
    session = { user: { id: "owner", sessionVersion: 7 } };
    const response = await route.POST(request()); assert.equal(response.status, 200); assert.deepEqual(await response.json(), { deleted: true });
    assert.match(response.headers.get("cache-control"), /private, no-store/); assert.deepEqual(calls, [["owner", body.currentPassword, 7]]);
  } finally { if (previous === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = previous; }
});

test("switching the browser cookie to another account with the same password cannot delete either account", () => fixture(async ({ db, owner, other, password, service }) => {
  const previous = process.env.NEXTAUTH_URL; process.env.NEXTAUTH_URL = "https://console.example.invalid";
  let session = { user: { id: owner.id, sessionVersion: 0 } };
  const helper = load("../../src/lib/auth/account-email-http.ts", { "./password": passwords, "./account-email": email, "@/lib/shared/http-input": load("../../src/lib/shared/http-input.ts"), "./auth": { authOptions: {} }, "next-auth": { getServerSession: async () => session } });
  const route = load("../../src/app/api/auth/delete-account/route.ts", { "@/lib/auth/account-deletion": { accountDeletionService: service }, "@/lib/auth/account-email-http": helper, "@/lib/auth/account-email": email, "@/lib/auth/password": passwords });
  const confirmedBody = { currentPassword: password, expectedAccountId: owner.id, confirmation: "DELETE" };
  try {
    assert.ok(await passwords.verifyPassword(password, other.passwordHash), "the switched account deliberately has the same valid password");
    session = { user: { id: other.id, sessionVersion: 0 } };
    const response = await route.POST(new Request(process.env.NEXTAUTH_URL + "/api/auth/delete-account", { method: "POST", headers: { origin: process.env.NEXTAUTH_URL }, body: JSON.stringify(confirmedBody) }));
    assert.equal(response.status, 409); assert.equal((await response.json()).code, "ACCOUNT_CHANGED");
    assert.equal(await db.user.count(), 2); assert.equal(await db.agent.count(), 2);
    for (const account of [owner, other]) assert.equal((await db.user.findUnique({ where: { id: account.id } })).sessionVersion, 0);
  } finally { if (previous === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = previous; }
}));

test("lost, invalid or server-error deletion replies remain uncertain and never trigger another POST", async () => {
  for (const response of [() => { throw new TypeError("offline"); }, () => Response.json({ error: "internal" }, { status: 500 }), () => Response.json({ ok: true }), () => Response.json({ deleted: true }, { status: 202 }), () => new Response("bad-json")]) {
    let calls = 0;
    const result = await client.requestAccountDeletion("synthetic-password", "owner", async (url, options) => {
      calls++; assert.equal(url, "/api/auth/delete-account"); assert.equal(options.method, "POST"); assert.deepEqual(JSON.parse(options.body), { currentPassword: "synthetic-password", confirmation: "DELETE", expectedAccountId: "owner" }); return response();
    });
    assert.equal(calls, 1); assert.equal(result.state, "uncertain");
  }
  assert.equal((await client.requestAccountDeletion("synthetic-password", "owner", async () => Response.json({ error: "wrong password", code: "INVALID_PASSWORD" }, { status: 400 }))).state, "rejected");
  const success = await client.requestAccountDeletion("synthetic-password", "owner", async () => Response.json({ deleted: true, consoleUrn: "urn:console:owner" }));
  assert.equal(success.state, "deleted"); assert.equal(success.consoleUrn, "urn:console:owner");
});

test("Gateway revocation is checked before deletion and a failure keeps local account data", () => fixture(async ({ db, owner, password }) => {
  const events = [];
  const guarded = deletion.createAccountDeletionService({ db, revokeWorkspaces: async userId => {
    events.push(userId); throw new Error("synthetic gateway unavailable");
  } });
  await assert.rejects(guarded.deleteAccount(owner.id, "wrong-password", 0), error => error.code === "INVALID_PASSWORD");
  assert.deepEqual(events, []);
  await assert.rejects(guarded.deleteAccount(owner.id, password, 1), error => error.code === "ACCOUNT_CHANGED");
  assert.deepEqual(events, []);
  await assert.rejects(guarded.deleteAccount(owner.id, password, 0), error => error.code === "WORKSPACE_REVOKE_UNCONFIRMED" && error.status === 503);
  assert.deepEqual(events, ["owner"]);
  assert.equal((await db.user.findUnique({ where: { id: owner.id } })).sessionVersion, 0);
  assert.equal(await db.agent.count(), 2);
}));

test("Gateway terminal revocation precedes successful local removal for the exact account", () => fixture(async ({ db, owner, other, password }) => {
  const events = [];
  const guarded = deletion.createAccountDeletionService({ db, revokeWorkspaces: async userId => {
    assert.ok(await db.user.findUnique({ where: { id: userId } }));
    events.push(userId);
  } });
  assert.equal((await guarded.deleteAccount(owner.id, password, 0)).deleted, true);
  assert.deepEqual(events, [owner.id]);
  assert.equal(await db.user.findUnique({ where: { id: owner.id } }), null);
  assert.ok(await db.user.findUnique({ where: { id: other.id } }));
}));


test("workspace revoke refusal is an explicit deletion rejection that the user may retry", async () => {

  const message = "工作区远程访问撤销尚未确认，账户未删除。请稍后重试。";
  const result = await client.requestAccountDeletion("synthetic-password", "owner", async () => Response.json({ error: message, code: "WORKSPACE_REVOKE_UNCONFIRMED" }, { status: 503 }));
  assert.equal(result.state, "rejected");
  assert.equal(result.message, message);
});
