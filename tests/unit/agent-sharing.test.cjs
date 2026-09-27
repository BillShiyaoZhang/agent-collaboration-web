const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), Module = require('node:module'), test = require('node:test'), ts = require('typescript');
function load(relative, deps = {}, append = '') {
 const filename = path.resolve(__dirname, relative), m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
 m.require = name => Object.hasOwn(deps, name) ? deps[name] : Module.prototype.require.call(m, name);
 m._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText + append, filename);
 return m.exports;
}
const sharing = load('../../src/lib/product/agent-sharing.ts');
const agent = { id: 'owned-a', name: 'My Agent', urn: 'urn:agent:owned-a' };
const other = { id: 'owned-b', name: 'Other Agent', urn: 'urn:agent:owned-b' };
const session = { accountId: 'account-a', loginSessionId: 'login-1', sessionVersion: 2 };
function gateFixture() {
 let current = { ...session }, origin = 'https://workspace.invalid', read = async () => current;
 const permission = sharing.createAgentSharingPermission(() => read(), () => origin); permission.select(agent);
 const shown = [];
 const access = {
  get allowed() { return !!permission.capture(agent); }, manage: async () => {},
  request: async () => { const captured = permission.capture(agent); const context = await permission.verify(agent); if (!context) return null; if (!captured) { shown.push(context); return null; } return permission.capture(agent) === captured ? captured : null; },
  validate: token => permission.validate(agent, token),
 };
 return { permission, access, shown, setSession: value => { current = value; }, setOrigin: value => { origin = value; }, setRead: value => { read = value; },
  allow: async () => { const context = await permission.verify(agent); assert.ok(permission.allow(context)); return permission.capture(agent); } };
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function hooks() {
 const slots = [], effects = []; let index = 0;
 const React = {
  createContext: () => ({ current: null }), useContext: context => context.current,
  useState(initial) { const key = index++; if (!(key in slots)) slots[key] = typeof initial === 'function' ? initial() : initial; return [slots[key], next => { slots[key] = typeof next === 'function' ? next(slots[key]) : next; }]; },
  useRef(initial) { const key = index++; if (!(key in slots)) slots[key] = { current: initial }; return slots[key]; },
  useCallback: callback => { index++; return callback; },
  useEffect(callback, deps) { const key = index++; if (!slots[key] || deps.some((item, i) => !Object.is(item, slots[key][i]))) { slots[key] = deps; effects.push(callback); } },
 };
 return { React, render: callback => { index = 0; return callback(); }, flush: async () => { for (const effect of effects.splice(0)) effect(); await new Promise(done => setImmediate(done)); } };
}
const realClient = load('../../src/lib/control/workbench-client.ts');
function clientFixture() {
 const prepared = [], delivered = []; let counter = 0, handler = async () => ({});
 class Client {
  prepare(method, params = {}) { const call = { request_id: 'request-' + ++counter, method, params }; prepared.push(call); return call; }
  async execute(call) { delivered.push(call); return handler(call); }
 }
 return { Client, prepared, delivered, handler: callback => { handler = callback; } };
}
function workbenchFixture(f, safety = { version: 1, mode: 'owner_review', automatic_peer_model_execution: false }) {
 const runtime = hooks(), client = clientFixture();
 const initial = { agent, identity: { virtualUrn: 'urn:console:owner' }, sync: { status: 'ready' }, snapshots: { capabilities: { data: { peer_content_safety: safety, methods: ['conversation.send', 'contacts.list'].map(name => ({ name, available: true })) } } }, conversations: [], activeConversationId: '', activeConversationState: { draft: 'Original draft', archived: false, readAt: 0, scrollTop: null }, conversation: null, hasEarlierTurns: false, submission: null, operations: [], recordStates: [] };
 const drafts = load('../../src/lib/product/draft-cache.ts'), queue = load('../../src/lib/product/metadata-queue.ts');
 const workspace = load('../../src/lib/workspace/workspace-client.ts', { '@/lib/control/workbench-client': realClient });
 const { useWorkbench } = load('../../src/components/workbench/use-workbench.ts', {
  react: runtime.React, '@/lib/control/workbench-client': { ...realClient, WorkbenchClient: client.Client }, '@/lib/workspace/workspace-client': workspace,
  '@/components/workspace-provider': { useWorkspace: () => ({ cacheAgent() {}, requestSync: async () => {}, getDraft: () => undefined, saveDraft() {}, error: '' }), workspaceRequest: async () => initial },
  './use-workbench-mutations': { useWorkbenchMutations: () => ({ actions: [], ready: true }) }, '@/lib/product/metadata-queue': queue, '@/lib/product/draft-cache': drafts,
  './policy-disclosure': { usePolicyAccess: () => true }, '@/components/local-time': { useHydrated: () => true },
  './agent-sharing-permission': { useAgentSharingPermission: () => f.access }, '@/lib/product/agent-sharing': sharing,
 });
 return { client, render: () => runtime.render(() => useWorkbench(agent, initial)) };
}
function mutationFixture(f) {
 const runtime = hooks(), client = clientFixture(), ledger = []; let reserve = async body => ({ item: { call: body.call } });
 const policy = load('../../src/lib/workspace/workspace-mutation-policy.ts');
 const { useWorkbenchMutations } = load('../../src/components/workbench/use-workbench-mutations.ts', { react: runtime.React,
  '@/lib/control/workbench-client': { ...realClient, WorkbenchClient: client.Client }, '@/lib/workspace/workspace-mutation-policy': policy, '@/lib/product/agent-sharing': sharing });
 const oldFetch = global.fetch;
 global.fetch = async (_url, init) => { const body = init?.body ? JSON.parse(init.body) : null; ledger.push(body); return Response.json(body?.action === 'reserve' ? await reserve(body) : { items: [] }); };
 const input = { agentId: agent.id, consoleUrn: 'urn:console:owner', client: new client.Client(), sharing: f.access,
  invoke: async (_method, _params, call, grant) => {
   if (sharing.contentRequiresSharing(call.method, call.params) && (!grant || !await f.access.validate(grant))) return { blocked: true };
   return { result: await client.Client.prototype.execute(call) };
  }, canAddContact: true, canRespondApproval: true, canMutate: () => true, refresh: async () => {}, contacts: [], approvalDecisions: [], requests: [], messages: [], sentMessages: [] };
 return { client, ledger, render: () => runtime.render(() => useWorkbenchMutations(input)), initialize: async () => { runtime.render(() => useWorkbenchMutations(input)); await runtime.flush(); }, reserve: callback => { reserve = callback; }, restore: () => { global.fetch = oldFetch; } };
}
test('sharing grants are memory-only and bind workspace, account, login and exact Agent', async () => {
 const f = gateFixture(); assert.equal(await f.access.request(), null); assert.equal(f.permission.grant, null);
 const token = await f.allow(); assert.equal(await f.access.validate(token), true);
 f.permission.revoke(); await f.allow(); assert.equal(await f.access.validate(token), false, 'a new grant cannot revive an older click');
 for (const change of [{ ...session, accountId: 'other' }, { ...session, loginSessionId: 'login-2' }, { ...session, sessionVersion: 3 }, null]) {
  const current = await f.allow(); f.setSession(change); assert.equal(await f.access.validate(current), false); f.setSession(session);
 }
 const current = await f.allow(); f.setOrigin('https://other.invalid'); assert.equal(await f.access.validate(current), false);
 f.permission.select(other); assert.equal(f.permission.capture(agent), null); f.permission.select(agent); assert.equal(f.permission.capture(agent), null);
 assert.equal(gateFixture().permission.grant, null, 'cold page restores no grant');
});
test('late session verification cannot move permission back into an old Agent', async () => {
 const f = gateFixture(), pause = deferred(); f.setRead(() => pause.promise);
 const reading = f.permission.verify(agent); f.permission.select(other); pause.resolve(session);
 assert.equal(await reading, null); assert.equal(f.permission.context, null); assert.equal(f.permission.grant, null);
});
test('real sharing hook never resumes an earlier click after consent was accepted while checking session', async () => {
 const f = gateFixture(), displayed = await f.permission.verify(agent), runtime = hooks(), shown = [];
 const ui = load('../../src/components/workbench/agent-sharing-permission.tsx', { react: runtime.React, 'next-auth/react': {}, '@/components/ui/button': {}, '@/components/ui/dialog': {}, '@/lib/product/agent-sharing': sharing }, '\nexports.testContext = SharingContextProvider;');
 ui.testContext.current = { permission: f.permission, open: context => shown.push(context), changed: 0 };
 const access = runtime.render(() => ui.useAgentSharingPermission(agent)); await runtime.flush();
 const pause = deferred(); f.setRead(() => pause.promise); const request = access.request();
 assert.ok(f.permission.allow(displayed)); pause.resolve(session);
 assert.equal(await request, null); assert.equal(shown.length, 0, 'permission does not retain an old send callback');
});
test('real send and invoke gates stop fresh messages and exact retries before preparing or dispatching', async () => {
 const f = gateFixture(), w = workbenchFixture(f), view = w.render();
 await view.sendMessage(); await view.invoke('messages.send', { text: 'Secret' });
 await view.sendMessage({ text: 'Retry', call: { request_id: 'old-id', method: 'conversation.send', params: { text: 'Retry' } }, conversationId: 'old-id', turnId: 'old-turn' });
 assert.equal(w.client.prepared.length, 0); assert.equal(w.client.delivered.length, 0);
 await view.invoke('contacts.list'); assert.equal(w.client.delivered.length, 1, 'saved/remote reads need no content permission');
});
test('real conversation digest await rechecks the same grant before dispatch', async () => {
 const f = gateFixture(); await f.allow(); const w = workbenchFixture(f), view = w.render();
 const pause = deferred(), entered = deferred(), originalDigest = crypto.subtle.digest;
 crypto.subtle.digest = async (...args) => { entered.resolve(); await pause.promise; return originalDigest.apply(crypto.subtle, args); };
 try {
  const pending = view.sendMessage(); await entered.promise;
  assert.equal(w.client.prepared.length, 1); f.permission.revoke(); await f.allow(); pause.resolve(); await pending;
  assert.equal(w.client.delivered.length, 0, 'a replaced permission cannot authorize a prepared message');
 } finally { crypto.subtle.digest = originalDigest; }
});
test('mutation denial also covers retries and restart without reserving original content', async () => {
 const f = gateFixture(), m = mutationFixture(f);
 try { await m.initialize(); const view = m.render(), original = { call: { request_id: 'original', method: 'messages.send', params: { message_id: 'msg', text: 'Private' } }, phase: 'uncertain', retryable: true };
  await view.run('messages.send', original.call.params); await view.retry(original); await view.restart({ ...original, retryable: false });
  assert.equal(m.ledger.filter(item => item?.action === 'reserve').length, 0); assert.equal(m.client.delivered.length, 0);
 } finally { m.restore(); }
});
test('revocation and regrant after durable reservation stop dispatch and preserve the exact retry', async () => {
 const f = gateFixture(); await f.allow(); const m = mutationFixture(f), pause = deferred(), entered = deferred();
 try { await m.initialize(); m.reserve(async body => { entered.resolve(); await pause.promise; return { item: { call: body.call } }; });
  const run = m.render().run('messages.send', { message_id: 'stable-message', text: 'Reserved content' }); await entered.promise;
  f.permission.revoke(); await f.allow(); pause.resolve(); await run;
  assert.equal(m.client.delivered.length, 0); const original = m.render().actions[0]; assert.equal(original.phase, 'uncertain');
  m.client.handler(async call => ({ message_id: call.params.message_id, status: 'queued' })); await m.render().retry(original);
  assert.equal(m.client.delivered.length, 1); assert.deepEqual(m.client.delivered[0], original.call);
 } finally { m.restore(); }
});
test('already dispatched mutation receipts stay factual when permission is withdrawn', async () => {
 const f = gateFixture(); await f.allow(); const m = mutationFixture(f), pause = deferred(), entered = deferred();
 try { await m.initialize(); m.client.handler(async call => { entered.resolve(); await pause.promise; return { message_id: call.params.message_id, status: 'queued' }; });
  const run = m.render().run('messages.send', { message_id: 'sent-message', text: 'Dispatched content' }); await entered.promise;
  f.permission.revoke(); pause.resolve(); await run; assert.equal(m.render().actions[0].phase, 'succeeded');
  await m.render().run('messages.send', { message_id: 'future-message', text: 'Future' }); assert.equal(m.client.delivered.length, 1);
 } finally { m.restore(); }
});
test('real safety block/unblock and read acknowledgements remain available after declining AI sharing', async () => {
 const f = gateFixture(), m = mutationFixture(f);
 try { await m.initialize(); m.client.handler(async call => call.method === 'inbox.mark_read' ? { message_id: call.params.message_id, status: 'read' } : call.method === 'inbox.review' ? { message_id: call.params.message_id, status: call.params.decision === 'approve' ? 'approved' : 'rejected', fingerprint: 'a'.repeat(64), sender_urn: 'urn:agent:peer' } : { urn: call.params.urn, status: call.method === 'contacts.block' ? 'blocked' : 'unblocked', blocked: call.method === 'contacts.block', safety_revision: 1, connection_status: call.method === 'contacts.block' ? 'blocked' : 'unverified' });
  await m.render().run('contacts.block', { urn: 'urn:agent:peer' }); await m.render().run('contacts.unblock', { urn: 'urn:agent:peer' }); await m.render().run('inbox.mark_read', { message_id: 'received' }); await m.render().run('inbox.review', { message_id: 'reviewed', decision: 'reject' });
  assert.equal(m.client.delivered.length, 4); assert.equal(f.shown.length, 0);
  assert.ok(m.render().actions.every(item => item.phase === 'succeeded'));
  assert.equal(sharing.contentRequiresSharing('collaboration.execute', { action: 'describe' }), false);
  assert.equal(sharing.contentRequiresSharing('new.content.method'), true, 'unreviewed future methods cannot bypass sharing permission');
 } finally { m.restore(); }
});
test('an unconfirmed safety action remains scoped to its URN and cannot stop blocking another peer', async () => {
 const f = gateFixture(), m = mutationFixture(f);
 try {
  await m.initialize(); m.client.handler(async call => ({ urn: call.params.urn === 'urn:agent:peer-a' ? 'urn:agent:wrong-peer' : call.params.urn, status: 'blocked', blocked: true, safety_revision: 1, connection_status: 'blocked' }));
  await m.render().run('contacts.block', { urn: 'urn:agent:peer-a' }); assert.equal(m.render().actions[0].phase, 'uncertain');
  await m.render().run('contacts.block', { urn: 'urn:agent:peer-b' });
  assert.equal(m.client.delivered.length, 2); assert.equal(f.shown.length, 0);
  assert.equal(m.render().actions.find(item => item.call.params.urn === 'urn:agent:peer-b').phase, 'succeeded');
  assert.equal(m.render().actions.find(item => item.call.params.urn === 'urn:agent:peer-a').phase, 'uncertain');
 } finally { m.restore(); }
});
test('safety receipts cannot claim success without a matching connection status', async () => {
 const f = gateFixture(), m = mutationFixture(f);
 try {
  await m.initialize(); m.client.handler(async call => ({ urn: call.params.urn, status: call.method === 'contacts.block' ? 'blocked' : 'unblocked', blocked: call.method === 'contacts.block', safety_revision: 1, connection_status: call.params.urn.endsWith('missing') ? undefined : call.method === 'contacts.block' ? 'connected' : 'blocked' }));
  await m.render().run('contacts.block', { urn: 'urn:agent:block-missing' });
  await m.render().run('contacts.block', { urn: 'urn:agent:block-wrong' });
  await m.render().run('contacts.unblock', { urn: 'urn:agent:unblock-missing' });
  await m.render().run('contacts.unblock', { urn: 'urn:agent:unblock-wrong' });
  assert.equal(m.client.delivered.length, 4); assert.equal(f.shown.length, 0);
  assert.ok(m.render().actions.every(item => item.phase === 'uncertain'));
 } finally { m.restore(); }
});
test('legacy Agent safety blocks conversation creation while preserving reads and the sharing grant', async () => {
 const f = gateFixture(); await f.allow(); const w = workbenchFixture(f, {});
 assert.equal(w.render().canSend, false); assert.match(w.render().conversationSafetyError, /runtime\/helper/);
 await w.render().sendMessage(); assert.equal(w.client.prepared.length, 0);
 assert.equal((await w.render().invoke('conversation.send', { text: 'must not dispatch' })).blocked, true);
 assert.equal(w.client.prepared.length, 0); assert.equal(f.access.allowed, true);
 await w.render().invoke('contacts.list'); assert.equal(w.client.delivered.length, 1);
});
