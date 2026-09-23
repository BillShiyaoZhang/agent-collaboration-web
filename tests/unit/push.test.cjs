const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');
const { PrismaClient } = require('@prisma/client');
const webpush = require('web-push');
function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), result = new Module(filename, module);
  result.filename = filename; result.paths = Module._nodeModulePaths(path.dirname(filename));
  result.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(result, name);
  result._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return result.exports;
}
class ControlError extends Error { constructor(message, status) { super(message); this.status = status; } }
const policy = load('../../src/lib/notifications/push-policy.ts');
const migration = fs.readFileSync(path.resolve(__dirname, '../../prisma/remote-console.sql'), 'utf8');
async function fixture(run) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-web-push-')), filename = path.join(folder, 'test.db');
  const db = new PrismaClient({ datasources: { db: { url: `file:${filename.replaceAll('\\', '/')}` } } });
  const oldSecret = process.env.NEXTAUTH_SECRET, oldUrl = process.env.NEXTAUTH_URL, oldDisabled = process.env.WEB_PUSH_DISABLED;
  process.env.NEXTAUTH_SECRET = 'isolated-push-test-secret'; process.env.NEXTAUTH_URL = 'https://app.example.invalid'; delete process.env.WEB_PUSH_DISABLED;
  const makeStore = () => load('../../src/lib/notifications/push-store.ts', { '@/lib/shared/db': { prisma: db }, '@/lib/control/control-transport': { ControlError }, './push-policy': policy });
  try {
    for (const sql of migration.replace(/^\s*--.*$/gm, '').split(';').filter(value => value.trim())) await db.$executeRawUnsafe(sql);
    for (const id of ['owner', 'other']) await db.user.create({ data: { id, email: `${id}@example.invalid`, passwordHash: 'fixture' } });
    await db.agent.create({ data: { id: 'agent', userId: 'owner', name: 'private-name', urn: 'urn:test:push', publicKey: 'fixture' } });
    const device = crypto.randomUUID(), keys = webpush.generateVAPIDKeys();
    const input = { endpoint: `https://fcm.googleapis.com/fcm/send/${device}`, expirationTime: null, keys: { p256dh: keys.publicKey, auth: crypto.randomBytes(16).toString('base64url') } };
    const store = makeStore();
    const subscribe = (userId = 'owner', deviceId = device, value = input) => store.savePushSubscription(userId, deviceId, value);
    const notice = async (changes = {}) => {
      const n = { id: 'notice', kind: 'owner_decision_required', state: 'open', revision: 1, read: 0, sourceAt: Date.now(), updatedAt: Date.now(), expiry: null, eligible: 1, ...changes };
      await db.$executeRawUnsafe('INSERT OR REPLACE INTO "WorkspaceNotification" ("agentId","id","kind","state","revision","readRevision","sourceAt","updatedAt","expiresAt","systemEligible","payload") VALUES (?,?,?,?,?,?,?,?,?,?,?)', 'agent', n.id, n.kind, n.state, n.revision, n.read, n.sourceAt, n.updatedAt, n.expiry, n.eligible, 'private-exact-authorization-and-chat-content');
      return n;
    };
    await run({ db, filename, store, makeStore, device, input, subscribe, notice });
  } finally {
    await db.$disconnect();
    for (const [key, value] of [['NEXTAUTH_SECRET', oldSecret], ['NEXTAUTH_URL', oldUrl], ['WEB_PUSH_DISABLED', oldDisabled]]) value === undefined ? delete process.env[key] : process.env[key] = value;
    fs.rmSync(folder, { recursive: true });
  }
}
test('push endpoint validation rejects arbitrary, private, lookalike and non-HTTPS destinations', () => {
  for (const endpoint of ['http://fcm.googleapis.com/send/a', 'https://127.0.0.1/a', 'https://fcm.googleapis.com.evil.invalid/a', 'https://user@fcm.googleapis.com/a', 'https://fcm.googleapis.com:8443/a', 'https://fcm.googleapis.com/a#token', 'https://notify.windows.com/a']) assert.equal(policy.allowedPushEndpoint(endpoint), false, endpoint);
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/a', 'https://updates.push.services.mozilla.com/wpush/v2/a', 'https://wns2-example.notify.windows.com/w/?token=a', 'https://web.push.apple.com/a']) assert.equal(policy.allowedPushEndpoint(endpoint), true);
});

test('browser transitions finish an in-flight bind before opt-out and recover after failed cleanup', async () => {
  const { browserPushTransition } = load('../../src/lib/notifications/browser-push.ts'), calls = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const bind = browserPushTransition(async () => { calls.push('binding'); await gate; calls.push('bound'); });
  const clear = browserPushTransition(async () => { calls.push('clear'); throw new Error('cleanup failed'); });
  const again = browserPushTransition(async () => { calls.push('new-intent'); });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(calls, ['binding']);
  release(); await bind; await assert.rejects(clear, /cleanup failed/); await again;
  assert.deepEqual(calls, ['binding', 'bound', 'clear', 'new-intent']);
});
test('VAPID and endpoint material persist encrypted, and endpoint ownership cannot cross accounts', () => fixture(async ({ db, store, makeStore, subscribe, input, device }) => {
  const first = await subscribe(), second = await makeStore().getPushSettings('owner', device);
  assert.equal(first.publicKey, second.publicKey); assert.equal(first.subscription.binding, second.subscription.binding);
  await assert.rejects(subscribe('other', crypto.randomUUID()), { status: 409 });
  const dump = JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM "WebPushSubscription"')) + JSON.stringify(await db.$queryRawUnsafe('SELECT * FROM "WebPushConfig"'));
  for (const value of [input.endpoint, input.keys.auth, input.keys.p256dh, first.publicKey]) assert.equal(dump.includes(value), false);
  await store.revokePushSubscription('other', device);
  assert.ok((await store.getPushSettings('owner', device)).subscription);
}));
test('persistent sender sends only opaque IDs, shares device claims with tabs, and duplicate ticks do not resend', () => fixture(async ({ db, store, subscribe, notice }) => {
  await subscribe(); await notice(); const calls = [];
  const send = async (...args) => { calls.push(args); return { statusCode: 201 }; };
  await Promise.all([store.runPushTick(send), store.runPushTick(send)]); await store.runPushTick(send);
  assert.equal(calls.length, 1);
  const [destination, payload, options] = calls[0], envelope = JSON.parse(payload);
  assert.equal(destination.endpoint.startsWith('https://fcm.googleapis.com/'), true);
  assert.deepEqual(Object.keys(envelope).sort(), ['binding', 'deliveryId', 'expiresAt', 'schema']);
  assert.equal(payload.includes('private'), false); assert.ok(options.TTL <= 900 && options.TTL > 0);
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "WorkspaceNotificationDelivery"')).length, 1);
  assert.equal((await db.$queryRawUnsafe('SELECT "readRevision" FROM "WorkspaceNotification"'))[0].readRevision, 0);
}));
test('an earlier tab claim prevents a duplicate Web Push attempt on the same device', () => fixture(async ({ db, store, subscribe, notice, device }) => {
  await subscribe(); await notice();
  await db.$executeRawUnsafe('INSERT INTO "WorkspaceNotificationDelivery" VALUES (?,?,?,?,?)', 'agent', 'notice', 1, device, Date.now());
  await store.runPushTick(async () => { throw new Error('must not send'); });
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "WebPushDelivery"')).length, 0);
}));
test('retries preserve delivery identity and recover an expired sending lease after restart', () => fixture(async ({ db, store, makeStore, subscribe, notice }) => {
  await subscribe(); await notice(); const ids = [];
  await store.runPushTick(async (_sub, payload) => { ids.push(JSON.parse(payload).deliveryId); throw Object.assign(new Error('private endpoint transport error'), { statusCode: 503 }); });
  const failed = (await db.$queryRawUnsafe('SELECT * FROM "WebPushDelivery"'))[0];
  assert.equal(failed.status, 'pending'); assert.equal(failed.claimed, 1); assert.equal(failed.lastError, 'push_service_unavailable');
  await db.$executeRawUnsafe('UPDATE "WebPushDelivery" SET "status"=\'sending\',"leaseUntil"=0,"nextAttemptAt"=0');
  await makeStore().runPushTick(async (_sub, payload) => { ids.push(JSON.parse(payload).deliveryId); return { statusCode: 201 }; });
  assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "WebPushDelivery"'))[0].status, 'sent');
}));
test('read, expired and stale source notifications never become push jobs', () => fixture(async ({ db, store, subscribe, notice }) => {
  await subscribe(); await notice({ id: 'read', read: 1 }); await notice({ id: 'expired', expiry: Date.now() - 1 }); await notice({ id: 'stale', sourceAt: Date.now() - 180000 }); await notice({ id: 'resolved', state: 'resolved' });
  await store.runPushTick(async () => { throw new Error('must not send'); });
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "WebPushDelivery"')).length, 0);
}));
test('idle push maintenance does not contend with a control writer', () => fixture(async ({ db, filename, store, subscribe }) => {
  const sub = await subscribe();
  const now = Date.now();
  await db.$executeRawUnsafe('INSERT INTO "WebPushDelivery" ("id","subscriptionId","agentId","notificationId","revision","status","nextAttemptAt","expiresAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)',
    'closed-delivery', sub.subscription.id, 'agent', 'old-notification', 1, 'closed', now - 1000, now - 1000, now);
  const writer = new PrismaClient({ datasources: { db: { url: `file:${filename.replaceAll('\\', '/')}` } } });
  let signalLocked, releaseWriter;
  const locked = new Promise(resolve => { signalLocked = resolve; });
  const release = new Promise(resolve => { releaseWriter = resolve; });
  const transaction = writer.$transaction(async tx => {
    await tx.$executeRawUnsafe('UPDATE "User" SET "email"="email" WHERE "id"=\'owner\'');
    signalLocked();
    await release;
  }, { timeout: 10000 });
  await locked;
  const tick = store.runPushTick(async () => { throw new Error('no push is due'); });
  let completed = false;
  tick.then(() => { completed = true; }, () => { completed = true; });
  try {
    await new Promise(resolve => setTimeout(resolve, 1000));
    assert.equal(completed, true, 'an idle tick must not wait for the SQLite write lock');
    await tick;
  } finally {
    releaseWriter();
    await transaction;
    await tick.catch(() => {});
    await writer.$disconnect();
  }
}));
test('display revalidates current account, binding, revocation and notification revision', () => fixture(async ({ db, store, subscribe, notice, device }) => {
  const settings = await subscribe(); await notice(); let envelope;
  await store.runPushTick(async (_sub, payload) => { envelope = JSON.parse(payload); return { statusCode: 201 }; });
  const resolve = () => store.resolvePushDisplay('owner', envelope.deliveryId, envelope.binding);
  const display = await resolve(); assert.equal(display.valid, true); assert.equal(display.body.includes('private'), false);
  await assert.rejects(store.resolvePushDisplay('other', envelope.deliveryId, envelope.binding), { status: 404 });
  await assert.rejects(store.resolvePushDisplay('owner', envelope.deliveryId, 'x'.repeat(32)), { status: 404 });
  await db.$executeRawUnsafe('UPDATE "WorkspaceNotification" SET "revision"=2'); assert.equal((await resolve()).valid, false);
  await db.$executeRawUnsafe('UPDATE "WorkspaceNotification" SET "revision"=1');
  await store.revokePushSubscription('owner', device); assert.equal((await resolve()).valid, false);
  assert.equal((await store.getPushSettings('owner', device)).subscription, null);
  assert.equal(settings.subscription.accountId, 'owner');
}));
test('foreground presence defers normal pushes while explicit test is bounded and business-state-free', () => fixture(async ({ db, store, subscribe, notice, device }) => {
  await subscribe(); await notice(); await store.updatePushPresence('owner', device, true);
  const sent = []; await store.runPushTick(async (_sub, payload) => { sent.push(payload); return { statusCode: 201 }; }); assert.equal(sent.length, 0);
  await store.queuePushTest('owner', device); await assert.rejects(store.queuePushTest('owner', device), { status: 429 });
  await store.runPushTick(async (_sub, payload) => { sent.push(payload); return { statusCode: 201 }; }); assert.equal(sent.length, 1);
  const envelope = JSON.parse(sent[0]); assert.equal((await store.resolvePushDisplay('owner', envelope.deliveryId, envelope.binding)).test, true);
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "WorkspaceNotificationDelivery"')).length, 0);
  await store.updatePushPresence('owner', device, false); await store.runPushTick(async (_sub, payload) => { sent.push(payload); return { statusCode: 201 }; }); assert.equal(sent.length, 2);
}));
test('410 revokes only the failed subscription and stops retries', () => fixture(async ({ db, store, subscribe, notice, device }) => {
  await subscribe(); await notice(); let count = 0;
  await store.runPushTick(async () => { count++; throw Object.assign(new Error('gone'), { statusCode: 410 }); });
  await store.runPushTick(async () => { count++; return { statusCode: 201 }; });
  assert.equal(count, 1); assert.equal((await store.getPushSettings('owner', device)).subscription, null);
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "WebPushDelivery"'))[0].status, 'failed');
}));
test('a fast service-worker receipt cannot be overwritten by the sender completion', () => fixture(async ({ db, store, subscribe, notice }) => {
  await subscribe(); await notice();
  await store.runPushTick(async (_sub, payload) => {
    const envelope = JSON.parse(payload); assert.equal((await store.resolvePushDisplay('owner', envelope.deliveryId, envelope.binding)).valid, true);
    await store.recordPushReceipt('owner', envelope.deliveryId, envelope.binding, 'displayed'); return { statusCode: 201 };
  });
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "WebPushDelivery"'))[0].status, 'displayed');
}));
test('push-service acceptance without a browser receipt retries the same opaque delivery finitely', () => fixture(async ({ db, store, subscribe, notice }) => {
  await subscribe(); await notice(); const ids = [];
  const send = async (_sub, payload) => { ids.push(JSON.parse(payload).deliveryId); return { statusCode: 201 }; };
  await store.runPushTick(send);
  for (let attempt = 0; attempt < 6; attempt++) { await db.$executeRawUnsafe('UPDATE "WebPushDelivery" SET "updatedAt"=?', Date.now() - 31000); await store.runPushTick(send); }
  assert.equal(ids.length, 5); assert.equal(new Set(ids).size, 1);
}));
test('focus classification includes an unhidden browser window behind another app', () => {
  const { browserIsAway } = load('../../src/lib/notifications/browser-push.ts');
  assert.equal(browserIsAway(false, true), false); assert.equal(browserIsAway(false, false), true); assert.equal(browserIsAway(true, true), true);
});

test('foreground arrival defers a real persisted delivery, retries it when away, and terminal receipts cannot be downgraded', () => fixture(async ({ db, store, subscribe, notice, device }) => {
  await subscribe(); await notice(); const sent = [];
  const send = async (_sub, payload) => { const value = JSON.parse(payload); sent.push(value); return { statusCode: 201 }; };
  await store.runPushTick(send);
  const envelope = sent[0], resolve = () => store.resolvePushDisplay('owner', envelope.deliveryId, envelope.binding);
  assert.equal((await resolve()).valid, true);
  await store.recordPushReceipt('owner', envelope.deliveryId, envelope.binding, 'deferred');
  await db.$executeRawUnsafe('UPDATE "WebPushDelivery" SET "updatedAt"=?,"nextAttemptAt"=0', Date.now() - 31000);
  await store.updatePushPresence('owner', device, true); await store.runPushTick(send); assert.equal(sent.length, 1);
  await store.updatePushPresence('owner', device, false); await store.runPushTick(send); assert.equal(sent.length, 2);
  assert.equal(sent[1].deliveryId, envelope.deliveryId); assert.equal((await resolve()).valid, true);
  await store.recordPushReceipt('owner', envelope.deliveryId, envelope.binding, 'displayed');
  for (const status of ['deferred', 'suppressed', 'display_error']) await store.recordPushReceipt('owner', envelope.deliveryId, envelope.binding, status);
  assert.equal((await db.$queryRawUnsafe('SELECT "status" FROM "WebPushDelivery"'))[0].status, 'displayed');
  assert.equal((await db.$queryRawUnsafe('SELECT * FROM "WorkspaceNotificationDelivery"')).length, 1);
}));

test('already queued foreground rows cannot starve another account from the next insertion batch', () => fixture(async ({ db, store, subscribe, notice, device, input }) => {
  await subscribe(); await store.updatePushPresence('owner', device, true);
  const otherDevice = crypto.randomUUID(); await subscribe('other', otherDevice, { ...input, endpoint: `https://fcm.googleapis.com/fcm/send/${otherDevice}` });
  await db.agent.create({ data: { id: 'other-agent', userId: 'other', name: 'Other', urn: 'urn:test:other', publicKey: 'fixture' } });
  await db.$executeRawUnsafe('INSERT INTO "WorkspaceNotification" ("agentId","id","kind","state","revision","readRevision","sourceAt","updatedAt","systemEligible","payload") VALUES (?,?,?,?,?,?,?,?,?,?)', 'other-agent', 'older', 'owner_decision_required', 'open', 1, 0, Date.now(), Date.now(), 1, 'fixture');
  for (let index = 0; index < 100; index++) await notice({ id: `newer-${index}` });
  const sent = [];
  const send = async (subscription, _payload) => { sent.push(subscription.endpoint); return { statusCode: 201 }; };
  await store.runPushTick(send); assert.equal(sent.length, 0);
  await store.runPushTick(send); assert.deepEqual(sent, [`https://fcm.googleapis.com/fcm/send/${otherDevice}`]);
}));

test('agent-resolved notifications send one verified dismissal wakeup to closed browsers', () => fixture(async ({ db, store, subscribe, notice }) => {
  await subscribe(); await notice(); const calls = [];
  const send = async (_subscription, payload) => { calls.push(JSON.parse(payload)); };
  await store.runPushTick(send);
  assert.equal(calls.length, 1);
  await db.$executeRawUnsafe('UPDATE "WebPushDelivery" SET "status"=\'displayed\'');
  await db.$executeRawUnsafe('UPDATE "WorkspaceNotification" SET "state"=\'resolved\',"revision"=2');
  await store.runPushTick(send); await store.runPushTick(send);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].action, 'reconcile'); assert.equal(calls[1].deliveryId, calls[0].deliveryId);
  assert.equal((await db.$queryRawUnsafe('SELECT "status" FROM "WebPushDelivery"'))[0].status, 'closed');
}));
