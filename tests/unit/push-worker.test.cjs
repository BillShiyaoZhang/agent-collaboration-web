const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { IDBFactory } = require('fake-indexeddb');
const source = fs.readFileSync(path.resolve(__dirname, '../../public/agent-comm-sw.js'), 'utf8');
function worker() {
  const handlers = {}, notices = [], calls = [], receipts = [];
  const binding = 'b'.repeat(32), deliveryId = 'd'.repeat(32);
  let current = { valid: true, accountId: 'owner', binding, deliveryId, expiresAt: Date.now() + 100000, title: 'Generic reminder', body: 'Generic body', tag: 'agent-comm-push:subscription:notice', test: false }, windows = [], beforeShow = async () => {};
  const self = { location: { origin: 'https://app.example.invalid' }, addEventListener: (name, fn) => { handlers[name] = fn; }, skipWaiting: async () => {},
    registration: { getNotifications: async () => notices.filter(item => !item.closed), showNotification: async (title, data) => { await beforeShow(); notices.push({ title, ...data, close() { this.closed = true; } }); } },
    clients: { claim: async () => {}, matchAll: async () => windows, openWindow: async value => calls.push(value) } };
  vm.runInNewContext(source, { self, indexedDB: new IDBFactory(), URL, Date, fetch: async (_url, options) => {
    const body = JSON.parse(options.body); calls.push(body);
    if (body.action === 'receipt') receipts.push(body.status);
    return { ok: true, json: async () => body.action === 'resolve' ? current : { saved: true } };
  } });
  async function event(name, data = {}) { let work; handlers[name]({ ...data, waitUntil: promise => { work = promise; } }); await work; }
  const bind = (accountId = 'owner', value = binding) => event('message', { data: { action: 'bind', accountId, binding: value }, source: { url: 'https://app.example.invalid/dashboard' }, ports: [] });
  const push = (changes = {}) => event('push', { data: { json: () => ({ schema: 'agent-comm-push/v1', binding, deliveryId, expiresAt: Date.now() + 100000, ...changes }) } });
  return { bind, push, event, notices, calls, receipts, setCurrent: value => { current = { ...current, ...value }; }, setWindows: value => { windows = value; }, beforeShow: fn => { beforeShow = fn; } };
}
test('service worker atomically deduplicates concurrent/replayed pushes in IndexedDB', async () => {
  const w = worker(); await w.bind(); await Promise.all([w.push(), w.push()]); await w.push();
  assert.equal(w.notices.length, 1); assert.ok(w.receipts.length >= 1); assert.ok(w.receipts.every(status => status === 'displayed'));
});
test('expired, revoked, other-account and former subscription messages cannot display', async () => {
  const w = worker(); await w.bind(); await w.push({ expiresAt: Date.now() - 1 }); assert.equal(w.notices.length, 0);
  w.setCurrent({ valid: false }); await w.push(); assert.equal(w.notices.length, 0);
  w.setCurrent({ valid: true, accountId: 'other' }); await w.push(); assert.equal(w.notices.length, 0);
  w.setCurrent({ accountId: 'owner' }); await w.bind('other', 'c'.repeat(32)); await w.push(); assert.equal(w.notices.length, 0);
});
test('focused visible clients get an in-app refresh while a visible unfocused client permits a system notice', async () => {
  const w = worker(), messages = []; await w.bind(); w.setWindows([{ focused: true, visibilityState: 'visible', postMessage: item => messages.push(item) }]);
  await w.push(); assert.equal(w.notices.length, 0); assert.equal(messages.length, 1); assert.deepEqual(w.receipts, ['deferred']);
  w.setWindows([{ focused: false, visibilityState: 'visible', postMessage() {} }]); await w.push(); assert.equal(w.notices.length, 1);
});
test('explicit tests display in foreground and click only opens the fixed notification center', async () => {
  const w = worker(); await w.bind(); w.setCurrent({ test: true }); w.setWindows([{ focused: true, visibilityState: 'visible', postMessage() {} }]);
  await w.push(); assert.equal(w.notices.length, 1); w.setWindows([]);
  await w.event('notificationclick', { notification: w.notices[0] });
  assert.equal(w.calls.at(-1), 'https://app.example.invalid/dashboard/notifications');
});
test('local opt-out clears worker binding and closes existing notices before old queued pushes arrive', async () => {
  const w = worker(); await w.bind(); await w.push(); assert.equal(w.notices.length, 1);
  await w.event('message', { data: { action: 'clear' }, source: { url: 'https://app.example.invalid/dashboard' }, ports: [] });
  assert.equal(w.notices[0].closed, true); await w.push({ deliveryId: 'e'.repeat(32) }); assert.equal(w.notices.length, 1);
});

test('opt-out and account switch finish only after an in-flight display has been closed', async () => {
  for (const action of ['clear', 'bind']) {
    const w = worker(); await w.bind();
    let release, entered;
    const showing = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
    w.beforeShow(async () => { entered(); await gate; });
    const pushing = w.push(); await showing;
    let completed = false;
    const changing = w.event('message', { data: { action, accountId: 'other', binding: 'c'.repeat(32) }, source: { url: 'https://app.example.invalid/dashboard' }, ports: [] }).then(() => { completed = true; });
    await new Promise(resolve => setImmediate(resolve)); assert.equal(completed, false);
    release(); await Promise.all([pushing, changing]);
    assert.equal(w.notices.filter(notice => !notice.closed).length, 0, action);
    await w.push({ deliveryId: 'e'.repeat(32) }); assert.equal(w.notices.filter(notice => !notice.closed).length, 0, action);
  }
});
