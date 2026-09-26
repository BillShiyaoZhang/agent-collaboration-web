const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const api = require('..');
const workspace = require('../fixtures/workspace-agent.json');
const call = require('../fixtures/control-send.json');
const complete = require('../fixtures/control-complete.json');
const pending = require('../fixtures/control-pending.json');
const rejected = require('../fixtures/control-pairing-error.json');
const policy = require('../fixtures/policy-cases.json');
const schema = require('../contract.schema.json');

test('attention feed validates bounded versions and resumes pagination only when explicitly paired', () => {
  const fixture = require('../fixtures/attention-page.json');
  assert.deepEqual(api.validateAttentionPage(fixture), fixture);
  for (const bad of [{ cursor: -1 }, { cursor: 6 }, { items: [{ ...fixture.items[0], target: { kind: 'url', id: 'https://peer.invalid' } }] }, { items: [{ ...fixture.items[0], revision: 1.5 }] }, { has_more: 'yes' }]) assert.throws(() => api.validateAttentionPage({ ...fixture, ...bad }), /Invalid attention/);
  const state = structuredClone(workspace), now = state.snapshots.capabilities.time;
  state.snapshots['attention.list'] = { data: { cursor: 7, has_more: true }, time: now };
  assert.equal(api.syncReadPlan(state, [], now).some(item => item.method === 'attention.list'), false);
  state.snapshots.capabilities.data.methods.push({ name: 'attention.list', available: true });
  assert.deepEqual(api.syncReadPlan(state, [], now).find(item => item.method === 'attention.list'), { method: 'attention.list', params: { after: 7, limit: 100 } });
  assert.equal(api.nextCycleDelay(state), 0);
  assert.equal(api.attentionRequiresAction('owner_decision_required', 'resolved'), false);
  assert.equal(api.attentionRequiresAction('collaboration_completed', 'open'), false);
  assert.equal(api.attentionRequiresAction('needs_response', 'open'), true);
  assert.equal(api.notificationRoute('agent/1', { kind: 'approval', id: '../../evil' }), '/dashboard/agents/agent%2F1?tab=tasks&subject=..%2F..%2Fevil');
});

test('package works in plain Node without the web app, React, Prisma or browser storage', () => {
  const run = spawnSync(process.execPath, ['-e', `const c=require(${JSON.stringify(path.resolve(__dirname, '..'))}); if(c.CONTROL_PROTOCOL!=='agent-comm-control/v1')process.exit(1)`], { cwd: require('node:os').tmpdir(), encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(Object.keys(require('../package.json').dependencies || {}).length, 0);
});

test('language-neutral schema and fixtures share the supported methods and field shapes', () => {
  assert.deepEqual(schema.$defs.rpcMethod.enum, api.RPC_METHODS);
  assert.equal(schema.$defs.stableId.pattern, api.STABLE_ID_PATTERN);
  assert.equal(policy.contractVersion, api.CONTRACT_VERSION);
  for (const name of schema.$defs.workspaceAgent.required) assert.ok(Object.hasOwn(workspace, name), name);
  for (const name of schema.$defs.pendingCall.required) assert.ok(Object.hasOwn(call, name), name);
  assert.equal(api.remoteTimestamp(workspace.conversation.turns[0].updated_at), workspace.snapshots['conversation.get'].time);
  assert.equal(workspace.conversation.turns[1].response, null);
  assert.equal(workspace.submission.call.request_id, call.request_id);
  assert.equal(workspace.submission.text, call.params.text);
});

test('canonical complete response binds every identity and correlation field', () => {
  const response = complete.response;
  assert.deepEqual(api.validateControlResponse(response, response), response);
  for (const name of ['request_id', 'agent_urn', 'console_urn', 'deadline', 'method']) {
    assert.throws(() => api.validateControlResponse({ ...response, [name]: 'other' }, response), /does not match/, name);
  }
  assert.throws(() => api.validateControlResponse({ ...response, error: { code: 'rejected', message: 'no' } }, response), /exactly one/);
  assert.throws(() => api.validateControlResponse({ ...response, params: {} }, response), /protocol/);
  assert.throws(() => api.validateControlResponse({ ...rejected.response, error: null }, rejected.response), /Invalid control error/);
});

test('canonical polling returns only authenticated completion, then still tracks the queued turn', async () => {
  const requests = [];
  const client = new api.WorkbenchClient('agent-a', async (url, init) => {
    requests.push({ url, ...init });
    return Response.json(requests.length === 1 ? pending : complete, { status: requests.length === 1 ? 202 : 200 });
  }, async ms => assert.equal(ms, api.CONTROL_POLL_MS), () => call.request_id);
  assert.deepEqual(await client.execute(client.prepare(call.method, call.params), new AbortController().signal), complete.response.result);
  assert.equal(requests[0].body, JSON.stringify(call));
  assert.match(requests[1].url, new RegExp(`request_id=${call.request_id}`));
  assert.equal(api.conversationSettled(workspace.conversation, ['turn-2']), false, 'queue acknowledgement is not a completed answer');
});

test('ambiguous transport failure retries exact ID and payload, terminal pairing error permits a new intent', async () => {
  let attempts = 0;
  const sent = [];
  const client = new api.WorkbenchClient('agent-a', async (_url, init) => {
    sent.push(init.body);
    if (++attempts === 1) throw new Error('lost after enqueue');
    return Response.json(rejected);
  }, async () => {}, () => call.request_id);
  const prepared = client.prepare(call.method, call.params);
  await assert.rejects(client.execute(prepared, new AbortController().signal), error => error.uncertain && error.retryable);
  assert.strictEqual(client.prepare(call.method, call.params), prepared);
  await assert.rejects(client.execute(prepared, new AbortController().signal), error => !error.uncertain && !error.retryable);
  assert.equal(sent[0], sent[1]);
  assert.notStrictEqual(client.prepare(call.method, call.params), prepared);
});

test('pairing policy vectors normalize seconds, milliseconds, ISO dates and invalid expiry consistently', () => {
  for (const example of policy.pairing) assert.equal(api.pairingAllowsSend({ pairing: { expires_at: example.expiresAt } }, workspace.sync, example.now), example.allowed, JSON.stringify(example));
  assert.equal(api.pairingAllowsSend({}, { ...workspace.sync, status: 'needs_pairing' }), false);
  assert.equal(api.pairingAllowsSend({}, { ...workspace.sync, status: 'policy_paused' }), false);
  assert.equal(api.pairingAllowsSend({}, { ...workspace.sync, status: 'policy_unavailable' }), false);
  for (const code of api.PAIRING_ERROR_CODES) assert.equal(api.isPairingError(code), true);
  assert.equal(api.isPairingError('queue_full'), false);
  for (const example of policy.backoff) assert.equal(api.syncBackoff(example.failures), example.milliseconds);
});

test('advertised extensions and writes cannot enter the fixed automatic read plan', () => {
  const state = structuredClone(workspace);
  state.snapshots.capabilities.data.methods.push({ name: 'approval.respond', available: true }, { name: 'contacts.add', available: true }, { name: 'custom.write', available: true });
  const methods = api.availableMethods(state.snapshots.capabilities.data);
  assert.ok(methods.includes('approval.respond'));
  assert.ok(methods.includes('contacts.add'));
  assert.ok(!methods.includes('custom.write'));
  const plan = api.syncReadPlan(state, ['chat-1', 'bad/id', 'chat-1'], state.snapshots.capabilities.time + 30000);
  assert.deepEqual(plan.map(item => item.method), ['collaboration.state', 'conversation.get']);
  assert.deepEqual(plan[1].params, { conversation_id: 'chat-1' });
});

test('completed actions refresh agent snapshots even when an earlier in-flight read was saved later', () => {
  const state = structuredClone(workspace), now = state.snapshots.capabilities.time;
  state.submission = null;
  state.conversations = [];
  state.snapshots['collaboration.state'] = { data: {}, time: now + 20, sourceAt: now - 10 };
  state.snapshots['contacts.add'] = { data: { status: 'confirmed' }, time: now + 10 };
  assert.equal(api.nextCycleDelay(state), 0);
  assert.deepEqual(api.syncReadPlan(state, [], now + 20), [{ method: 'collaboration.state', params: {} }]);
  state.snapshots['collaboration.state'].sourceAt = now + 11;
  assert.deepEqual(api.syncReadPlan(state, [], now + 20), []);
  assert.equal(api.nextCycleDelay(state), api.SYNC_INTERVAL_MS);
});

test('saved content and terminal turns survive stale refresh while authenticated late results can recover local uncertainty', () => {
  const current = workspace.snapshots;
  assert.strictEqual(api.mergeSnapshots(current, { capabilities: { data: {}, time: 1 } }).capabilities, current.capabilities);
  for (const status of policy.terminalTurns) assert.equal(api.mergeTurns([{ turn_id: 'turn', status }], [{ turn_id: 'turn', status: 'running' }])[0].status, status);
  assert.equal(api.mergeTurns([{ turn_id: 'turn', status: 'interrupted', locally_unconfirmed: true }], [{ turn_id: 'turn', status: 'completed', response: '真实结果' }])[0].response, '真实结果');
});

test('canonical JSON ignores object order while preserving array order, values and scope', () => {
  assert.equal(api.canonicalJSON({ params: { text: '原消息', conversation_id: 'chat' }, id: 'one' }), api.canonicalJSON({ id: 'one', params: { conversation_id: 'chat', text: '原消息' } }));
  assert.notEqual(api.canonicalJSON({ params: ['a', 'b'] }), api.canonicalJSON({ params: ['b', 'a'] }));
  assert.notEqual(api.canonicalJSON({ a: null }), api.canonicalJSON({}));
  const client = new api.WorkbenchClient('agent', async () => { throw new Error('unused'); });
  assert.strictEqual(client.prepare('conversation.send', { text: 'go', conversation_id: 'chat' }), client.prepare('conversation.send', { conversation_id: 'chat', text: 'go' }));
});

test('friend request targets route to contacts and social writes only invalidate reads', () => {
  const c = require('../index.js');
  assert.equal(c.attentionRequiresAction('friend_request_received', 'open'), true);
  assert.equal(c.notificationRoute('agent', { kind: 'contact', id: 'request-1' }), '/dashboard/agents/agent?tab=contacts&subject=request-1');
  for (const method of ['contacts.respond', 'messages.send', 'inbox.mark_read', 'collaboration.execute']) assert.equal(c.AUTOMATIC_METHODS.has(method), false);
  assert.equal(c.AUTOMATIC_METHODS.has('contacts.requests'), true);
});

test('conversation result notices deep-link the exact turn without demanding an owner action', () => {
  const page = require('../fixtures/attention-conversation-page.json');
  assert.deepEqual(api.validateAttentionPage(page), page);
  const target = page.items[0].target;
  assert.equal(api.notificationRoute('agent/a', target), '/dashboard/agents/agent%2Fa?tab=conversation&conversation=chat-1&turn=turn-1');
  assert.equal(api.attentionRequiresAction('conversation_completed', 'open'), false);
  assert.equal(api.attentionRequiresAction('conversation_failed', 'open'), false);
  for (const turn_id of [undefined, 'bad/id', '']) {
    const invalid = structuredClone(page);
    invalid.items[0].target.turn_id = turn_id;
    assert.throws(() => api.validateAttentionPage(invalid), /Invalid attention item/);
  }
});


test('authenticated write errors preserve the original action when execution cannot be ruled out', async () => {
  const methods = ['conversation.send', 'contacts.add', 'approval.respond', 'contacts.respond', 'messages.send', 'inbox.mark_read', 'collaboration.execute'];
  for (const method of methods) for (const code of ['internal_error', 'result_too_large', 'request_conflict', 'new_unknown_error']) {
    let ids = 0;
    const client = new api.WorkbenchClient('agent', async (_url, init) => {
      const sent = JSON.parse(init.body);
      return Response.json({status:'complete',request_id:sent.request_id,response:{request_id:sent.request_id,method:sent.method,error:{code,message:'failure after possible commit'}}});
    }, async () => {}, () => `request-${++ids}`);
    const original = client.prepare(method, {target:'same-object',content:'same-body'});
    await assert.rejects(client.execute(original, new AbortController().signal), error => error.uncertain && !error.retryable && error.call === original);
    assert.strictEqual(client.prepare(method, {content:'same-body',target:'same-object'}), original, `${method}/${code} must retain ID and payload`);
    assert.equal(ids, 1);
  }
});

test('authenticated pre-execution rejection and read errors allow a fresh request', async () => {
  for (const [method, codes] of [['messages.send',['not_paired','owner_mismatch','method_not_allowed','unsupported_method','invalid_params','queue_full','pairing_expired','pairing_revoked']], ['conversation.get',['internal_error','result_too_large','request_conflict']]]) {
    for (const code of codes) {
      let ids = 0;
      const client = new api.WorkbenchClient('agent', async (_url, init) => {
        const sent = JSON.parse(init.body);
        return Response.json({status:'complete',request_id:sent.request_id,response:{request_id:sent.request_id,method:sent.method,error:{code,message:'rejected'}}});
      }, async () => {}, () => `request-${++ids}`);
      const original = client.prepare(method, {text:'same'});
      await assert.rejects(client.execute(original, new AbortController().signal), error => !error.uncertain && !error.retryable);
      assert.notStrictEqual(client.prepare(method, {text:'same'}), original);
      assert.equal(ids, 2);
    }
  }
});
