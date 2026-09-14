const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");

function load(filename) {
  const loaded = new Module(filename, module);
  const originalRequire = loaded.require.bind(loaded);
  loaded.require = name => name.startsWith("./") ? load(path.resolve(path.dirname(filename), `${name}.ts`)) : originalRequire(name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText, filename);
  return loaded.exports;
}
const { mergeSnapshots, mergeTurns, syncLabel, pairingAllowsSend } = load(path.resolve(__dirname, "../src/lib/workspace-client.ts"));

test("late cache responses cannot replace a newer saved snapshot or advance its sync time", () => {
  const saved = { "contacts.list": { time: 200, data: { contacts: [{ contact_id: "new" }] } } };
  const stale = { "contacts.list": { time: 100, data: { contacts: [] } } };
  const merged = mergeSnapshots(saved, stale);
  assert.strictEqual(merged["contacts.list"], saved["contacts.list"]);
  assert.equal(merged["contacts.list"].time, 200);
  assert.deepEqual(mergeSnapshots(saved, {}), saved, "missing or failed reads retain saved content");
  const newer = { "contacts.list": { time: 300, data: { contacts: [] } } };
  assert.strictEqual(mergeSnapshots(saved, newer)["contacts.list"], newer["contacts.list"], "authenticated empty lists can replace old contacts");
});

test("turn refresh keeps loaded history while updating matching pending turns once", () => {
  const earlier = [
    { turn_id: "old", created_at: 1, status: "completed", response: "history" },
    { turn_id: "recent", created_at: 2, status: "running" },
  ];
  const latest = [{ turn_id: "recent", created_at: 2, status: "completed", response: "answer" }, { turn_id: "new", created_at: 3, status: "submitted" }];
  const turns = mergeTurns(earlier, latest);
  assert.deepEqual(turns.map(turn => turn.turn_id), ["old", "recent", "new"]);
  assert.equal(turns[1].response, "answer");
  assert.deepEqual(mergeTurns(turns, latest), turns, "repeated cache polling never duplicates turns");
  assert.equal(mergeTurns(turns, [{ turn_id: "recent", created_at: 2, status: "running" }])[1].status, "completed", "a delayed pending read cannot revive a completed turn");
  assert.equal(mergeTurns([{ turn_id: "unconfirmed", status: "interrupted", locally_unconfirmed: true }], [{ turn_id: "unconfirmed", status: "running" }])[0].status, "running", "an authenticated late result can recover a locally unconfirmed record");
  assert.equal(mergeTurns([{ turn_id: "interrupted", status: "interrupted" }], [{ turn_id: "interrupted", status: "running" }])[0].status, "interrupted", "an authenticated interrupted turn stays settled");
  assert.equal(earlier[1].status, "running", "merge does not mutate the visible prior snapshot");
});

test("offline and revoked pairing cannot be described as currently connected", () => {
  const state = { lastAttemptAt: 100, lastSuccessAt: 50, nextSyncAt: 200, error: null };
  assert.match(syncLabel({ ...state, status: "offline" }, true), /暂未连上.*已保存/);
  assert.match(syncLabel({ ...state, status: "needs_pairing" }, true), /重新配对.*已保存/);
  assert.match(syncLabel({ ...state, status: "syncing" }, true), /后台同步/);
  assert.equal(syncLabel({ ...state, status: "ready" }, true), "已同步");
});

test("cached capabilities cannot permit sending after pairing expires or requires reauthorization", () => {
  const sync = { status: "ready", lastAttemptAt: 100, lastSuccessAt: 50, nextSyncAt: 200, error: null };
  assert.equal(pairingAllowsSend({ pairing: { expires_at: 10 } }, sync, 10000), false);
  assert.equal(pairingAllowsSend({ pairing: { expires_at: 11 } }, sync, 10000), true);
  assert.equal(pairingAllowsSend({ pairing: { expires_at: "1970-01-01T00:00:10.000Z" } }, sync, 10000), false);
  assert.equal(pairingAllowsSend({ pairing: { expires_at: "invalid" } }, sync, 10000), false);
  assert.equal(pairingAllowsSend({}, { ...sync, status: "needs_pairing" }, 10000), false);
  assert.equal(pairingAllowsSend({}, sync, 10000), true, "legacy capabilities without an expiry still defer to their method authorization");
});
