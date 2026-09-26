const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../../src/components/workbench/collaboration-workflow-model.ts');
const loaded = new Module(filename, module);
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { buildGoalScope, localInputToUtc, contactsForSelection, currentApprovalsForTask, taskJudgment, peerCommunication, meetingProposalKind, collaborationMutationBlocksWrites } = loaded.exports;
const draft = { peerId: 'peer-one', goal: '与王明讨论方案', success: '双方同步确认三十分钟约定', topic: '产品方案讨论', windows: [{ start: '2030-01-02T10:00', end: '2030-01-02T12:00' }, { start: '2030-01-04T14:00', end: '2030-01-04T16:00' }], expiresAt: '2030-01-05T12:00', duration: 30, candidates: 3, actions: 12, resourceIds: ['resource-one', 'resource-one'], allowPropose: true, allowAccept: false, shareSlots: true };

test('a restored uncertain describe cannot lock writes or clear a real unknown prepare', () => {
  const legacyDescribe = { phase: 'uncertain', call: { method: 'collaboration.execute', params: { action: 'describe' } } };
  const unknownPrepare = { phase: 'uncertain', call: { method: 'collaboration.execute', params: { action: 'prepare_task', task_id: 'original-task' } } };
  assert.equal([legacyDescribe].some(collaborationMutationBlocksWrites), false);
  assert.equal([legacyDescribe, unknownPrepare].some(collaborationMutationBlocksWrites), true);
  assert.deepEqual([legacyDescribe, unknownPrepare].filter(collaborationMutationBlocksWrites), [unknownPrepare]);
  assert.equal(collaborationMutationBlocksWrites({ ...unknownPrepare, phase: 'sending' }), true);
  assert.equal(collaborationMutationBlocksWrites({ ...unknownPrepare, phase: 'succeeded' }), false);
  assert.equal(collaborationMutationBlocksWrites({ ...unknownPrepare, call: { method: 'collaboration.execute', params: {} } }), true, 'unknown actions do not gain read-only treatment');
});

test('goal form compiles only the strict mandate and keeps disjoint allowed windows', () => {
  const scope = buildGoalScope(draft, Date.UTC(2029, 0, 1));
  assert.deepEqual(Object.keys(scope).sort(), ['purpose', 'topic', 'capabilities', 'recipient_ids', 'participant_ids', 'resource_ids', 'window_start', 'window_end', 'allowed_windows', 'max_duration_minutes', 'max_candidates', 'max_actions', 'expires_at'].sort());
  assert.deepEqual(scope.recipient_ids, ['peer-one']);
  assert.deepEqual(scope.participant_ids, ['self', 'peer-one']);
  assert.deepEqual(scope.capabilities, ['propose_meeting', 'share_slots', 'share_resource']);
  assert.deepEqual(scope.resource_ids, ['resource-one']);
  assert.equal(scope.allowed_windows.length, 2);
  assert.equal(scope.window_start, scope.allowed_windows[0].start);
  assert.equal(scope.window_end, scope.allowed_windows[1].end);
  assert.match(scope.purpose, /目标：与王明讨论方案\n成功标准：双方同步确认三十分钟约定/);
  assert.equal(scope.capabilities.includes('accept_meeting'), false, 'a proposal preference cannot grant acceptance');
  assert.equal('worker' in scope, false, 'task permission cannot enable the worker');
});

test('missing conditions, expired grants and invalid calendar dates cannot prepare mandates', () => {
  const now = Date.UTC(2029, 0, 1);
  assert.throws(() => buildGoalScope({ ...draft, success: '' }, now), /成功标准/);
  assert.throws(() => buildGoalScope({ ...draft, expiresAt: '2020-01-01T00:00' }, now), /晚于现在/);
  assert.throws(() => buildGoalScope({ ...draft, windows: [{ start: '2030-01-02T12:00', end: '2030-01-02T10:00' }] }, now), /结束晚于开始/);
  assert.throws(() => localInputToUtc('2030-02-31T10:00', '开始'), /有效时间/);
  assert.throws(() => buildGoalScope({ ...draft, actions: 0 }, now), /有效/);
  assert.throws(() => buildGoalScope({ ...draft, allowPropose: false, shareSlots: false, resourceIds: [] }, now), /至少一项/);
});

test('contact selection requires established connections and omits self', () => {
  const contacts = contactsForSelection([{ contact_id: 'self', urn: 'urn:example:self', connection_status: 'connected' }, { contact_id: 'pending', urn: 'urn:example:pending', connection_status: 'pending' }, { contact_id: 'ready', urn: 'urn:example:ready', aliases: ['自己的称呼'], connection_status: 'connected' }]);
  assert.equal(contacts.length, 1);
  assert.equal(contacts[0].contact_id, 'ready');
  assert.equal(contacts[0].label, '自己的称呼');
});

test('approval association uses structured task and operation ids, never quoted peer content', () => {
  const data = { operations: [{ operation_id: 'op-one', task_id: 'task-one', approval_id: 'approval-op' }], pending_confirmations: [{ approval_id: 'approval-task', subject_id: 'task-one' }, { approval_id: 'approval-op', subject_id: 'op-one' }, { approval_id: 'unrelated', subject_id: 'task-two', question: 'task-one op-one' }] };
  assert.deepEqual(currentApprovalsForTask(data, 'task-one').map(approval => approval.approval_id), ['approval-task', 'approval-op']);
});

test('queued invitations and missing worker authorization remain separate from business completion', () => {
  const task = { task_id: 'one', status: 'active', scope: { purpose: '原目标' }, worker: { status: 'disabled' } };
  const invited = taskJudgment({}, task, { joined: false, phase: 'invited' });
  assert.match(invited.next, /等待对方加入/);
  assert.match(invited.result, /尚无双方完成/);
  const joined = taskJudgment({}, task, { joined: true, phase: 'negotiating' });
  assert.match(joined.next, /本人选择方案/);
  assert.match(joined.owner, /需要选择/);
  const allowedWorker = taskJudgment({}, { ...task, worker: { status: 'active' } }, { joined: true });
  assert.match(allowedWorker.next, /已批准策略/);
  const synchronized = taskJudgment({}, { ...task, worker: { status: 'expired' } }, { joined: true, agreement: { agreement_id: 'agreement' }, closure_reason: 'agreement_only_complete', agreement_synced: true });
  assert.match(synchronized.result, /未创建日历.*尚不代表会议已举行/);
  assert.equal(synchronized.owner, '无需作授权决定');
});

test('uncertain sends preserve the verification instruction even after permission withdrawal', () => {
  const result = taskJudgment({ operations: [{ operation_id: 'original', task_id: 'one', status: 'sending' }] }, { task_id: 'one', status: 'revoked', scope: {} }, { joined: true });
  assert.match(result.next, /核实原动作.*不要重复发送/);
  assert.match(result.progress, /停止新的业务动作.*既有协作结果保留/);
  assert.equal(result.owner, '先核实结果');
});

test('contact communication combines only that peer and retains each direction and source', () => {
  const messages = peerCommunication([{ message_id: 'received', sender_urn: 'urn:example:one', received_at: 20, text: '对方声明' }, { message_id: 'other', sender_urn: 'urn:example:two', received_at: 1 }], [{ message_id: 'sent', recipient_urn: 'urn:example:one', created_at: 10, status: 'accepted' }], 'urn:example:one');
  assert.deepEqual(messages.map(message => [message.message_id, message.direction]), [['sent', 'outgoing'], ['received', 'incoming']]);
  assert.equal(messages[1].sender_urn, 'urn:example:one');
  assert.equal(messages[0].status, 'accepted');
});

test('own cancellation waits for the peer while a peer cancellation requires the owner', () => {
  const task = { task_id: 'one', status: 'active', scope: {}, worker: { status: 'disabled' } };
  const base = { joined: true, agreement: { agreement_id: 'agreement' }, peer_urn: 'urn:example:peer', waiting_reason: 'cancel_decision' };
  const own = taskJudgment({}, task, { ...base, cancel_request: { sender_urn: 'urn:example:self' } });
  assert.match(own.next, /等待对方回应/);
  assert.equal(own.owner, '当前无需本人操作');
  const peer = taskJudgment({}, task, { ...base, cancel_request: { sender_urn: 'urn:example:peer' } });
  assert.match(peer.next, /本人核对对方/);
  assert.equal(peer.owner, '需要本人操作');
});

test('the initiator publishes revisions while the invited party requests changes', () => {
  assert.equal(meetingProposalKind({ initiator_urn: 'urn:example:self', peer_urn: 'urn:example:peer' }), 'proposal');
  assert.equal(meetingProposalKind({ initiator_urn: 'urn:example:peer', peer_urn: 'urn:example:peer' }), 'change_request');
});
