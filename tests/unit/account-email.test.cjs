const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const http = require("node:http");
const crypto = require("node:crypto");
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
const baseEnv = { NEXTAUTH_URL: "https://console.example.invalid", NODE_ENV: "production", RESEND_API_KEY: "test-not-a-real-key", AUTH_EMAIL_FROM: "Agent Comm <accounts@notify.example.invalid>", AUTH_EMAIL_REPLY_TO: "support@example.invalid", AUTH_EMAIL_DAILY_LIMIT: "90" };
async function fixture(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agent-comm-email-"));
  const filename = path.join(directory, "test.db");
  const db = new PrismaClient({ datasources: { db: { url: "file:" + filename.replaceAll("\\", "/") } } });
  const migrate = async () => {
    const sql = fs.readFileSync(path.resolve(__dirname, "../../prisma/remote-console.sql"), "utf8");
    for (const statement of sql.replace(/^\s*--.*$/gm, "").split(";").filter(value => value.trim())) await db.$executeRawUnsafe(statement);
    await migrateAccountEmail(db);
  };
  try { await callback({ db, migrate }); }
  finally { await db.$disconnect(); for (const suffix of ["", "-journal", "-wal", "-shm"]) if (fs.existsSync(filename + suffix)) fs.unlinkSync(filename + suffix); fs.rmdirSync(directory); }
}
async function providerStub(callback) {
  const requests = [];
  let status = 200, responseBody = { id: "stub-accepted" };
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk.toString();
    requests.push({ headers: request.headers, body: JSON.parse(body) });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(responseBody));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const endpoint = "http://127.0.0.1:" + server.address().port;
  const safeFetch = (url, options) => {
    assert.equal(url, "https://api.resend.com/emails");
    return fetch(endpoint + "/emails", options);
  };
  try { await callback({ requests, fetch: safeFetch, fail: () => { status = 500; }, accept: () => { status = 200; }, badReceipt: () => { responseBody = {}; } }); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
function tokenFrom(request) {
  const match = request.body.text.match(/https:\/\/console\.example\.invalid\/[^\s]+/);
  assert.ok(match); return new URL(match[0]).searchParams.get("token");
}
function rejectToken(promise) { return assert.rejects(promise, error => error.code === "INVALID_TOKEN" && error.status === 400); }

test("account migration is repeatable and preserves legacy identity, credentials and business records", async () => fixture(async ({ db, migrate }) => {
  await db.$executeRawUnsafe('CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "email" TEXT NOT NULL, "passwordHash" TEXT NOT NULL, "virtualUrn" TEXT, "virtualEd25519PublicKey" TEXT, "virtualEd25519PrivateKey" TEXT, "virtualX25519PublicKey" TEXT, "virtualX25519PrivateKey" TEXT, "virtualKeySalt" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL)');
  await db.$executeRawUnsafe('INSERT INTO "User" ("id","email","passwordHash","virtualUrn","virtualEd25519PrivateKey","updatedAt") VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)', "old-user", "Legacy@Example.invalid", "unchanged-hash", "urn:old:identity", "preserved-private-material");
  await db.$executeRawUnsafe('CREATE TABLE "Contact" ("id" TEXT PRIMARY KEY, "alias" TEXT)');
  await db.$executeRawUnsafe('INSERT INTO "Contact" VALUES (?,?)', "old-contact", "old-history");
  await migrate(); await migrate();
  const user = await db.user.findUnique({ where: { id: "old-user" } });
  assert.equal(user.passwordHash, "unchanged-hash"); assert.equal(user.virtualUrn, "urn:old:identity");
  assert.equal(user.virtualEd25519PrivateKey, "preserved-private-material");
  assert.equal(user.email, "Legacy@Example.invalid"); assert.equal(user.emailVerifiedAt, null);
  assert.equal(user.requiresEmailVerification, false); assert.equal(user.sessionVersion, 0);
  assert.deepEqual(await db.$queryRawUnsafe('SELECT * FROM "Contact"'), [{ id: "old-contact", alias: "old-history" }]);
}));

test("provider HTTP submission has trusted links, Reply-To, hashed tokens, one-time concurrent purpose-bound consumption", async () => fixture(async ({ db, migrate }) => {
  await migrate();
  await providerStub(async stub => {
    const timestamp = Date.UTC(2026, 8, 26);
    const service = email.createAccountEmailService({ db, env: baseEnv, fetch: stub.fetch, now: () => timestamp });
    const result = await service.register(" New@Example.invalid ", "safe-long-password", "/connect/example-code");
    assert.match(result.message, /尝试/);
    const user = await db.user.findUnique({ where: { email: "new@example.invalid" } });
    assert.equal(user.requiresEmailVerification, true); assert.equal(user.emailVerifiedAt, null);
    assert.equal(stub.requests.length, 1);
    const request = stub.requests[0], token = tokenFrom(request);
    assert.equal(request.headers.authorization, "Bearer test-not-a-real-key");
    assert.match(request.headers["idempotency-key"], /^account-email\//);
    assert.equal(request.body.reply_to, "support@example.invalid");
    assert.equal(request.body.from, baseEnv.AUTH_EMAIL_FROM);
    assert.match(request.body.html, /如果不是你本人操作/);
    assert.equal(token.length, 43);
    const row = await db.emailActionToken.findFirst();
    assert.equal(row.hash, crypto.createHash("sha256").update(token).digest("hex"));
    assert.equal(JSON.stringify(row).includes(token), false);
    await rejectToken(service.resetPassword(token, "reset-long-password"));
    assert.equal((await db.emailActionToken.findFirst()).consumedAt, null);
    const replay = await Promise.allSettled([service.verifyEmail(token), service.verifyEmail(token)]);
    assert.equal(replay.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(replay.filter(value => value.status === "rejected")[0].reason.code, "INVALID_TOKEN");
    assert.equal(replay.find(value => value.status === "fulfilled").value.callbackUrl, "/connect/example-code");
    const verified = await db.user.findUnique({ where: { id: user.id } });
    assert.equal(verified.requiresEmailVerification, false); assert.equal(verified.emailVerifiedAt.getTime(), timestamp);
    assert.equal(verified.sessionVersion, 0);
  });
}));

test("failed/uncertain submissions do not activate links or revoke older accepted links; expired tokens reject", async () => fixture(async ({ db, migrate }) => {
  await migrate();
  await providerStub(async stub => {
    let timestamp = Date.UTC(2026, 8, 26);
    const service = email.createAccountEmailService({ db, env: baseEnv, fetch: stub.fetch, now: () => timestamp });
    await service.register("retry@example.invalid", "safe-long-password");
    const accepted = tokenFrom(stub.requests[0]);
    timestamp += 61000; stub.fail();
    await service.resendVerification("retry@example.invalid");
    const failed = tokenFrom(stub.requests[1]);
    await rejectToken(service.verifyEmail(failed));
    assert.equal((await db.emailActionToken.findUnique({ where: { hash: crypto.createHash("sha256").update(accepted).digest("hex") } })).consumedAt, null);
    timestamp += 16000; stub.accept();
    await service.resendVerification("retry@example.invalid");
    const retried = tokenFrom(stub.requests[2]);
    await rejectToken(service.verifyEmail(accepted));
    timestamp += 24 * 60 * 60 * 1000 + 1;
    await rejectToken(service.verifyEmail(retried));
    assert.equal((await db.user.findUnique({ where: { email: "retry@example.invalid" } })).emailVerifiedAt, null);
    assert.equal((await db.authEmailBudget.findFirst()).used, 3, "provider attempts consume quota even on failure");
  });
}));

test("password changes wait for email confirmation; reset verifies ownership, changes version and invalidates stale actions", async () => fixture(async ({ db, migrate }) => {
  await migrate();
  await providerStub(async stub => {
    let timestamp = Date.UTC(2026, 8, 26);
    const service = email.createAccountEmailService({ db, env: baseEnv, fetch: stub.fetch, now: () => timestamp });
    const oldHash = await passwords.hashPassword("original-safe-password");
    const account = await db.user.create({ data: { email: "legacy@example.invalid", passwordHash: oldHash, virtualUrn: "urn:original:console" } });
    await assert.rejects(service.changePassword(account.id, "wrong", "new-safe-password"), { code: "INVALID_PASSWORD" });
    assert.equal(stub.requests.length, 0);
    await service.changePassword(account.id, "original-safe-password", "new-safe-password");
    assert.equal((await db.user.findUnique({ where: { id: account.id } })).passwordHash, oldHash);
    const changeToken = tokenFrom(stub.requests[0]);
    await rejectToken(service.verifyEmail(changeToken));
    timestamp += 61000;
    await service.forgotPassword("legacy@example.invalid");
    const resetToken = tokenFrom(stub.requests[1]);
    await service.resetPassword(resetToken, "recovered-safe-password");
    const changed = await db.user.findUnique({ where: { id: account.id } });
    assert.equal(changed.sessionVersion, 1); assert.equal(changed.emailVerifiedAt.getTime(), timestamp);
    assert.equal(changed.requiresEmailVerification, false); assert.equal(changed.virtualUrn, "urn:original:console");
    assert.equal(await passwords.verifyPassword("recovered-safe-password", changed.passwordHash), true);
    assert.equal(await passwords.verifyPassword("original-safe-password", changed.passwordHash), false);
    await rejectToken(service.confirmPasswordChange(changeToken)); await rejectToken(service.resetPassword(resetToken, "another-safe-password"));
    timestamp += 61000;
    await service.changePassword(account.id, "recovered-safe-password", "confirmed-safe-password");
    await service.confirmPasswordChange(tokenFrom(stub.requests[2]));
    assert.equal((await db.user.findUnique({ where: { id: account.id } })).sessionVersion, 2);
    await rejectToken(service.confirmPasswordChange(tokenFrom(stub.requests[2])));
  });
}));

test("persistent recipient cooldown and daily budget survive service instances, and public unknown accounts have generic replies", async () => fixture(async ({ db, migrate }) => {
  await migrate();
  await providerStub(async stub => {
    let timestamp = Date.UTC(2026, 8, 26);
    const env = { ...baseEnv, AUTH_EMAIL_DAILY_LIMIT: "2" };
    const service = () => email.createAccountEmailService({ db, env, fetch: stub.fetch, now: () => timestamp });
    await service().register("quota-a@example.invalid", "safe-long-password");
    const result = await service().resendVerification("quota-a@example.invalid");
    assert.equal(stub.requests.length, 1, "recipient cooldown persists");
    const unknown = await service().forgotPassword("missing@example.invalid");
    assert.deepEqual(result, unknown);
    timestamp += 61000; stub.fail();
    await service().register("quota-b@example.invalid", "safe-long-password");
    timestamp += 61000; stub.accept();
    await service().register("quota-c@example.invalid", "safe-long-password");
    assert.equal(stub.requests.length, 2); assert.equal((await db.authEmailBudget.findFirst()).used, 2);
    timestamp += 86400000;
    await service().resendVerification("quota-c@example.invalid");
    assert.equal(stub.requests.length, 3);
  });
}));

test("configuration fails uniformly before writes or network; old mixed-case email is never replaced or duplicated", async () => fixture(async ({ db, migrate }) => {
  await migrate();
  const hash = await passwords.hashPassword("preserved-safe-password");
  await db.user.create({ data: { id: "original-id", email: "Legacy@Example.invalid", passwordHash: hash } });
  const unconfigured = email.createAccountEmailService({ db, env: { ...baseEnv, RESEND_API_KEY: "" }, fetch: () => { throw new Error("must never send"); } });
  for (const call of [unconfigured.register("new@example.invalid", "safe-long-password"), unconfigured.forgotPassword("missing@example.invalid"), unconfigured.resendVerification("Legacy@example.invalid")]) await assert.rejects(call, { code: "EMAIL_NOT_CONFIGURED", status: 503 });
  assert.equal(await db.user.count(), 1); assert.equal(await db.authEmailSend.count(), 0);
  await providerStub(async stub => {
    const service = email.createAccountEmailService({ db, env: baseEnv, fetch: stub.fetch });
    await service.register("legacy@example.invalid", "attacker-other-password");
    const users = await db.user.findMany();
    assert.equal(users.length, 1); assert.equal(users[0].id, "original-id"); assert.equal(users[0].passwordHash, hash);
    assert.equal(users[0].email, "Legacy@Example.invalid");
  });
  for (const callback of ["//evil.example", "/\\evil.example", "/%2fevil.example", "/%5cevil", "https://evil.example", "/%00bad"]) assert.equal(email.safeEmailCallback(callback), "/dashboard");
  assert.equal(email.safeEmailCallback("/connect/claim?next=ok"), "/connect/claim?next=ok");
  for (const invalid of [{ NEXTAUTH_URL: "http://console.example.invalid" }, { AUTH_EMAIL_DAILY_LIMIT: "101" }, { AUTH_EMAIL_REPLY_TO: "support@example.invalid\r\nBcc: attacker" }]) assert.throws(() => email.accountEmailConfig({ ...baseEnv, ...invalid }), { code: "EMAIL_NOT_CONFIGURED" });
}));

test("concurrent SQLite reservations cannot exceed the daily budget", async () => fixture(async ({ db, migrate }) => {
  await migrate();
  const timestamp = Date.UTC(2026, 8, 26);
  for (let i = 0; i < 12; i++) await db.user.create({ data: { email: "concurrent-" + i + "@example.invalid", passwordHash: "fixture-unused-password" } });
  await providerStub(async stub => {
    const service = email.createAccountEmailService({ db, env: { ...baseEnv, AUTH_EMAIL_DAILY_LIMIT: "3" }, fetch: stub.fetch, now: () => timestamp });
    await Promise.all(Array.from({ length: 12 }, (_, i) => service.forgotPassword("concurrent-" + i + "@example.invalid")));
    assert.equal(stub.requests.length, 3); assert.equal((await db.authEmailBudget.findFirst()).used, 3);
    assert.equal(await db.emailActionToken.count({ where: { activeAt: { not: null } } }), 3);
  });
}));

test("password reset and email-confirmed change compete atomically, including two password-reset replays", async () => fixture(async ({ db, migrate }) => {
  await migrate();
  await providerStub(async stub => {
    let timestamp = Date.UTC(2026, 8, 26);
    const service = email.createAccountEmailService({ db, env: baseEnv, fetch: stub.fetch, now: () => timestamp });
    const account = await db.user.create({ data: { email: "race@example.invalid", passwordHash: await passwords.hashPassword("original-safe-password"), virtualUrn: "urn:existing:console" } });
    await service.changePassword(account.id, "original-safe-password", "email-change-password");
    timestamp += 61000;
    await service.forgotPassword(account.email);
    const outcomes = await Promise.allSettled([
      service.confirmPasswordChange(tokenFrom(stub.requests[0])),
      service.resetPassword(tokenFrom(stub.requests[1]), "email-reset-password"),
    ]);
    assert.equal(outcomes.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(outcomes.find(value => value.status === "rejected").reason.code, "INVALID_TOKEN");
    let updated = await db.user.findUnique({ where: { id: account.id } });
    assert.equal(updated.sessionVersion, 1); assert.equal(updated.virtualUrn, account.virtualUrn);
    assert.ok(updated.emailVerifiedAt); assert.equal(updated.requiresEmailVerification, false);
    const winningPassword = outcomes[0].status === "fulfilled" ? "email-change-password" : "email-reset-password";
    assert.equal(await passwords.verifyPassword(winningPassword, updated.passwordHash), true);
    timestamp += 61000;
    await service.forgotPassword(account.email);
    const token = tokenFrom(stub.requests[2]);
    const replays = await Promise.allSettled([
      service.resetPassword(token, "first-replay-password"),
      service.resetPassword(token, "second-replay-password"),
    ]);
    assert.equal(replays.filter(value => value.status === "fulfilled").length, 1);
    assert.equal(replays.find(value => value.status === "rejected").reason.code, "INVALID_TOKEN");
    updated = await db.user.findUnique({ where: { id: account.id } });
    assert.equal(updated.sessionVersion, 2);
    const replayWinner = replays[0].status === "fulfilled" ? "first-replay-password" : "second-replay-password";
    assert.equal(await passwords.verifyPassword(replayWinner, updated.passwordHash), true);
  });
}));

test("a stale provider response cannot revive consumed tokens or revoke links issued after a password reset", async () => fixture(async ({ db, migrate }) => {
  await migrate();
  await providerStub(async stub => {
    let timestamp = Date.UTC(2026, 8, 26), hold = false, started, release;
    const hasResponse = new Promise(resolve => { started = resolve; });
    const providerResume = new Promise(resolve => { release = resolve; });
    const controlledFetch = async (...args) => {
      const response = await stub.fetch(...args);
      if (hold) { hold = false; started(); await providerResume; }
      return response;
    };
    const service = email.createAccountEmailService({ db, env: baseEnv, fetch: controlledFetch, now: () => timestamp });
    const account = await db.user.create({ data: { email: "late-response@example.invalid", passwordHash: await passwords.hashPassword("original-safe-password") } });
    await service.forgotPassword(account.email);
    const firstToken = tokenFrom(stub.requests[0]);
    timestamp += 61000; hold = true;
    const pendingRequest = service.forgotPassword(account.email);
    await hasResponse;
    const staleToken = tokenFrom(stub.requests[1]);
    await service.resetPassword(firstToken, "new-generation-password");
    timestamp += 61000;
    await service.forgotPassword(account.email);
    const freshToken = tokenFrom(stub.requests[2]);
    release(); await pendingRequest;
    const stale = await db.emailActionToken.findUnique({ where: { hash: crypto.createHash("sha256").update(staleToken).digest("hex") } });
    assert.equal(stale.activeAt, null); assert.notEqual(stale.consumedAt, null);
    await rejectToken(service.resetPassword(staleToken, "stale-password"));
    await service.resetPassword(freshToken, "fresh-generation-password");
    assert.equal((await db.user.findUnique({ where: { id: account.id } })).sessionVersion, 2);
  });
}));

test("verification callbacks reject protocol-relative paths after URL normalization", () => {
  for (const callback of ["/..//evil.example", "/.//evil.example", "/%2e%2e//evil.example", "/%2e//evil.example", "/bad\u007fpath", "/%7fpath"]) {
    assert.equal(email.safeEmailCallback(callback), "/dashboard", callback);
  }
  assert.equal(email.safeEmailCallback("/connect/../connect/claim?next=ok"), "/connect/claim?next=ok");
});

test("invalid reset links are rejected before performing expensive password derivation", async () => fixture(async ({ db, migrate }) => {
  await migrate();
  let derivations = 0;
  const guarded = load("../../src/lib/auth/account-email.ts", {
    "@/lib/shared/db": { prisma: {} },
    "./password": { ...passwords, hashPassword: async () => { derivations++; throw new Error("must not derive an invalid reset"); } },
  });
  const service = guarded.createAccountEmailService({ db, env: baseEnv, fetch: () => { throw new Error("must not send"); } });
  for (const token of ["invalid", "a".repeat(43)]) await rejectToken(service.resetPassword(token, "safe-long-password"));
  assert.equal(derivations, 0);
}));

test("transactional email works without a reply mailbox and never promises manual replies", async () => fixture(async ({ db, migrate }) => {
  await migrate();
  await providerStub(async stub => {
    for (const replyTo of [undefined, ""]) {
      const service = email.createAccountEmailService({ db, env: { ...baseEnv, AUTH_EMAIL_REPLY_TO: replyTo }, fetch: stub.fetch });
      await service.register("no-reply-" + stub.requests.length + "@example.invalid", "safe-long-password");
      const request = stub.requests.at(-1);
      assert.equal(Object.hasOwn(request.body, "reply_to"), false, "omit the header entirely when no reply mailbox is configured");
      assert.doesNotMatch(request.body.text + request.body.html, /直接回复|人工客服/);
      assert.match(request.body.text, /系统自动发送/);
    }
    for (const purpose of ["verify-email", "reset-password", "change-password"]) {
      const content = email.accountEmailContent(purpose, "https://console.example.invalid/" + purpose);
      assert.doesNotMatch(content.text + content.html, /直接回复|人工客服/);
    }
  });
}));
