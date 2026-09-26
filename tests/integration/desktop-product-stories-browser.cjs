// Fresh PRODUCT_FIXTURE=1, built Web and synthetic signed-MQ identities only.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const base = 'http://127.0.0.1:3062', platform = 'http://127.0.0.1:3061', out = path.resolve(__dirname, '../../build/workspace-sync-preview/desktop-product');
const checks = [], errors = [], writes = [], metadataWrites = [], recordWrites = []; let browser, activePage;
const isControl = (request, method, action) => request.method() === 'POST' && request.url().endsWith('/control') && request.postDataJSON().method === method && (!action || request.postDataJSON().params.action === action);

async function activeConversation(context) {
  const response = await context.request.get(base + '/api/agents/agent-a1/workspace');
  assert.equal(response.ok(), true);
  return (await response.json()).activeConversationId;
}
// Next preserves hidden route trees during transitions; UI assertions inspect the
// current visible main content, while all independent API/state assertions remain.
function visibleInMain(page, selector) { return page.locator('main:visible').locator(selector).filter({ visible: true }); }
function visibleLabel(page, name) { return page.getByLabel(name, { exact: true }).filter({ visible: true }); }
function conversationRow(page, id) { return visibleInMain(page, '[data-conversation-id=' + JSON.stringify(id) + ']'); }
async function waitDraft(page, value, prefix = false) {
  await page.waitForFunction(({ value, prefix }) => {
    const input = Array.from(document.querySelectorAll('textarea[aria-label="给 agent 的消息"]')).find(element => element.getClientRects().length > 0);
    return input && (prefix ? input.value.startsWith(value) : input.value === value);
  }, { value, prefix });
}
async function selectConversation(page, id) {
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await visibleLabel(page, '搜索已保存对话').fill('');
  const selected = page.waitForResponse(response => response.request().method() === 'POST' && response.url().endsWith('/api/agents/agent-a1/workspace') && response.request().postDataJSON().action === 'select_conversation' && response.request().postDataJSON().conversationId === id);
  await conversationRow(page, id).getByRole('button', { name: /^打开对话 / }).click();
  const response = await selected; assert.equal(response.ok(), true); assert.equal((await response.json()).activeConversationId, id);
}
async function navigate(page, label) {
  const mobile = page.viewportSize().width < 768;
  const link = page.getByRole('navigation', { name: mobile ? '手机主导航' : '主导航', exact: true }).getByRole('link', { name: label, exact: true });
  const destination = new URL(await link.getAttribute('href'), base);
  await link.click();
  await page.waitForURL(url => url.pathname === destination.pathname && url.search === destination.search);
  if (label === '我的 agents') {
    await visibleInMain(page, '[data-my-agents-workspace]').waitFor();
    await visibleLabel(page, '给 agent 的消息').waitFor();
  } else {
    await page.getByRole('heading', { level: 1, name: label, exact: true }).waitFor();
    if (label === '合作' && !destination.searchParams.has('agent')) await visibleLabel(page, '搜索合作').waitFor();
  }
}
async function collaborations(page) {
  await navigate(page, '合作');
  await page.getByRole('combobox', { name: '合作所属 agent', exact: true }).selectOption('agent-a1');
  await page.waitForURL('**/dashboard/collaborations?agent=agent-a1');
}
async function originalChat(page, context, conversation) {
  await navigate(page, '我的 agents');
  await page.getByRole('button', { name: '与 同步测试 A1 聊天', exact: true }).click();
  await selectConversation(page, conversation);
  assert.equal(await activeConversation(context), conversation);
}
async function relatedDetails(page) {
  const summary = visibleInMain(page, 'summary').filter({ hasText: /^关联合作 ·/ });
  await summary.waitFor();
  if (!await summary.evaluate(element => element.parentElement.open)) await summary.click();
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  for (const artifact of ['results.json', 'failure.json', 'failure.png']) {
    const generated = path.join(out, artifact);
    if (fs.existsSync(generated)) fs.unlinkSync(generated);
  }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'Asia/Shanghai' });
  const page = await context.newPage(); activePage = page; page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.method() !== 'POST') return;
    if (request.url().endsWith('/control')) { const call = request.postDataJSON(); if (call.method !== 'collaboration.execute' || call.params.action !== 'describe') writes.push(call); }
    if (/\/workspace\/conversations$/.test(request.url())) metadataWrites.push(request.postDataJSON());
    if (/\/workspace\/records$/.test(request.url())) recordWrites.push(request.postDataJSON());
  });
  await page.goto(base + '/login'); await visibleLabel(page, '邮箱').fill('owner-a@workspace.invalid');
  await visibleLabel(page, '密码').fill('Workspace-smoke-fixture-2026');
  await page.getByRole('button', { name: '进入工作空间', exact: true }).click(); await page.waitForURL('**/dashboard/chats');
  assert.equal(writes.length, 0); await page.getByRole('button', { name: '与 同步测试 A1 聊天', exact: true }).click();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  const composer = visibleLabel(page, '给 agent 的消息');
  await composer.fill('产品旅程原始消息'); await visibleLabel(page, '发送消息').click();
  await visibleLabel(page, '对话记录').getByText('这是自动同步回来的回复', { exact: true }).waitFor({ timeout: 120000 });
  assert.equal(await visibleLabel(page, '对话记录').locator('table').count(), 1);
  checks.push('默认聊天入口，真实回执后保存格式化答复');
  const conversation = await activeConversation(context);
  await composer.fill('尚未发送的账号草稿'); await page.waitForTimeout(1100);
  await conversationRow(page, conversation).getByRole('button', { name: /^管理对话 / }).click();
  await page.getByRole('menuitem', { name: '重命名', exact: true }).click();
  await visibleLabel(page, '对话标题').fill('产品讨论主题');
  await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await visibleLabel(page, '搜索已保存对话').fill('产品旅程原始消息');
  await page.getByRole('button', { name: '打开对话 产品讨论主题', exact: true }).waitFor();
  await conversationRow(page, conversation).getByRole('button', { name: /^管理对话 / }).click();
  await page.getByRole('menuitem', { name: '归档对话', exact: true }).click(); await page.getByRole('button', { name: '归档', exact: true }).click();
  await page.getByRole('button', { name: '打开对话 产品讨论主题', exact: true }).waitFor(); checks.push('标题、搜索与归档保存到账户，原记录可恢复');
  await page.reload(); assert.equal(await composer.inputValue(), '尚未发送的账号草稿'); checks.push('刷新恢复账号草稿和原对话');

  // Create a second real fixture conversation, then inject a selection delay past the draft debounce.
  const unarchive = await context.request.post(base + '/api/agents/agent-a1/workspace/conversations', { headers: { Origin: base }, data: { conversationId: conversation, archived: false } }); assert.equal(unarchive.ok(), true);
  await page.getByRole('button', { name: '对话', exact: true }).click();
  await visibleLabel(page, '搜索已保存对话').fill('');
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await composer.fill('竞态第二个会话'); await visibleLabel(page, '发送消息').click();
  await visibleLabel(page, '对话记录').getByText('这是自动同步回来的回复', { exact: true }).waitFor({ timeout: 120000 });
  const targetConversation = await activeConversation(context);
  const savedDraft = page.waitForRequest(request => /\/workspace\/conversations$/.test(request.url()) && request.method() === 'POST' && request.postDataJSON().draft === '目标会话保留草稿');
  await composer.fill('目标会话保留草稿'); await savedDraft;
  await selectConversation(page, conversation);
  await composer.waitFor();
  await waitDraft(page, '尚未发送的账号草稿');
  const start = metadataWrites.length;
  await page.route('**/api/agents/agent-a1/workspace', async route => {
    const request = route.request();
    if (request.method() === 'POST' && request.postDataJSON().action === 'select_conversation' && request.postDataJSON().conversationId === targetConversation) await new Promise(resolve => setTimeout(resolve, 1500));
    await route.continue();
  });
  await selectConversation(page, targetConversation);
  await waitDraft(page, '目标会话保留草稿');
  assert.equal(metadataWrites.slice(start).some(patch => patch.conversationId === targetConversation && patch.draft === ''), false, 'slow selection cannot overwrite the unloaded target draft');
  await page.unroute('**/api/agents/agent-a1/workspace');
  await selectConversation(page, conversation);
  await waitDraft(page, '尚未发送的账号草稿');
  checks.push('会话选择延迟超过700ms，不向未加载目标写空草稿，两段草稿均保留');

  await collaborations(page);
  const readsBefore = metadataWrites.length;
  const inject = await fetch(platform + '/fixture/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productCompletion: true, conversation_id: conversation, due: true }) }); assert.equal(inject.ok, true);
  let backgroundSaved = false;
  for (let attempt = 0; attempt < 80; attempt++) {
    const saved = await (await context.request.get(base + '/api/agents/agent-a1/workspace')).json();
    if (saved.conversation?.turns.some(turn => turn.response === '后台完成，未在事项页阅读')) { backgroundSaved = true; break; }
    await page.waitForTimeout(250);
  }
  assert.equal(backgroundSaved, true, 'backend must save the synthetic completion while tasks are visible');
  await page.waitForTimeout(1100);
  assert.equal(metadataWrites.slice(readsBefore).some(patch => Object.hasOwn(patch, 'readAt')), false, 'background polling is not reading the chat');
  checks.push('停留事项页时，后台回合同步不会写readAt或关闭聊天新回复');

  await page.getByRole('button', { name: '发起合作', exact: true }).click();
  await visibleLabel(page, '合作对象').selectOption('product-peer');
  await visibleLabel(page, '合作目标').fill('与小林确定产品讨论时间');
  await visibleLabel(page, '成功标准').fill('双方同步确认三十分钟会议约定');
  await visibleLabel(page, '对外会议主题').fill('产品方案讨论');
  await visibleLabel(page, '时段 1 开始时间').fill('2030-01-10T14:00');
  await visibleLabel(page, '时段 1 结束时间').fill('2030-01-10T17:00');
  await visibleLabel(page, '授权截止时间').fill('2030-01-09T18:00');
  const preparedRequest = page.waitForRequest(request => isControl(request, 'collaboration.execute', 'prepare_task'));
  await page.getByRole('button', { name: '生成确切委托授权问题', exact: true }).click();
  const prepare = (await preparedRequest).postDataJSON();
  await visibleInMain(page, '#subject-approval-' + prepare.params.task_id).getByText('确切委托范围：', { exact: false }).waitFor();
  assert.equal(prepare.params.source_conversation_id, conversation); assert.deepEqual(prepare.params.scope.recipient_ids, ['product-peer']);
  assert.equal(writes.filter(call => call.params.action === 'dispatch').length, 0);
  await originalChat(page, context, conversation);
  await relatedDetails(page);
  await visibleInMain(page, '#subject-approval-' + prepare.params.task_id).getByText('确切委托范围：', { exact: false }).waitFor();
  const taskApproval = visibleInMain(page, '#subject-approval-' + prepare.params.task_id);
  const taskDecision = page.waitForRequest(request => isControl(request, 'approval.respond') && request.postDataJSON().params.approval_id === 'approval-' + prepare.params.task_id);
  await taskApproval.getByRole('button', { name: '同意本次请求', exact: true }).click(); await taskDecision;
  for (let attempt = 0; attempt < 80; attempt++) {
    const saved = await (await context.request.get(base + '/api/agents/agent-a1/workspace')).json();
    if (saved.snapshots['collaboration.state'].data.tasks.find(value => value.task_id === prepare.params.task_id)?.status === 'active') break;
    await page.waitForTimeout(250);
  }
  // The approval snapshot initially forces this disclosure open. Wait until
  // the committed UI removes that pending-approval prop before opening it again.
  await visibleInMain(page, 'summary').filter({ hasText: /^关联合作 · 1 项$/ }).waitFor();
  await relatedDetails(page);
  await page.locator('main:visible').getByText('委托已授权，尚未邀请或加入', { exact: true }).filter({ visible: true }).waitFor();
  checks.push('表单无需ID/JSON；仅确切审批授权，原聊天显示同一事项');
  await collaborations(page);
  const taskCard = visibleInMain(page, '#subject-' + prepare.params.task_id);
  const invitationRequest = page.waitForRequest(request => isControl(request, 'collaboration.execute', 'prepare_collaboration'));
  await taskCard.getByRole('button', { name: '生成确切邀请授权问题', exact: true }).click();
  const invitation = (await invitationRequest).postDataJSON();
  const invitationApproval = visibleInMain(page, '#subject-approval-' + invitation.params.operation_id);
  await invitationApproval.getByText('允许向小林发送本次会议邀请？', { exact: true }).waitFor();
  assert.equal(writes.filter(call => call.params.action === 'dispatch').length, 0);
  await invitationApproval.getByRole('button', { name: '同意本次请求', exact: true }).click();
  const dispatchRequest = page.waitForRequest(request => isControl(request, 'collaboration.execute', 'dispatch'));
  await taskCard.getByRole('button', { name: '执行已授权的邀请对方加入', exact: true }).click();
  const dispatched = (await dispatchRequest).postDataJSON(); assert.equal(dispatched.params.operation_id, invitation.params.operation_id);
  await taskCard.getByText('等待对方加入；当前无需重复邀请', { exact: true }).waitFor();
  assert.equal(await taskCard.getByRole('button', { name: '设置有限后台范围', exact: true }).count(), 0);
  checks.push('委托、邀请与真实dispatch分开；等待对方加入时不提前显示worker策略');

  await fetch(platform + '/fixture/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productPeerJoin: prepare.params.task_id, due: true }) });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await taskCard.getByRole('button', { name: '设置有限后台范围', exact: true }).click();
  await taskCard.getByLabel('后台最多检查次数', { exact: true }).fill('6');
  await taskCard.getByLabel('后台最多发送次数', { exact: true }).fill('4');
  await taskCard.getByLabel('后台检查间隔', { exact: true }).fill('60');
  await taskCard.getByLabel('后台策略截止时间', { exact: true }).fill('2030-01-08T18:00');
  const policyRequest = page.waitForRequest(request => isControl(request, 'collaboration.execute', 'prepare_worker_policy'));
  await taskCard.getByRole('button', { name: '准备本次动作并核对授权', exact: true }).click();
  const policy = (await policyRequest).postDataJSON().params.policy;
  assert.deepEqual({ max_runs: policy.max_runs, max_sends: policy.max_sends, interval_seconds: policy.interval_seconds, allow_propose: policy.allow_propose, allow_accept: policy.allow_accept, proposal: policy.proposal }, { max_runs: 6, max_sends: 4, interval_seconds: 60, allow_propose: false, allow_accept: true, proposal: null });
  const workerApproval = visibleInMain(page, '#subject-approval-worker-' + prepare.params.task_id);
  await workerApproval.getByRole('button', { name: '同意本次请求', exact: true }).click();
  await taskCard.getByRole('button', { name: '暂停后台运行', exact: true }).click();
  const pauseRequest = page.waitForRequest(request => isControl(request, 'collaboration.execute', 'pause_worker'));
  await taskCard.getByRole('button', { name: '确认执行本次操作', exact: true }).click();
  assert.equal((await pauseRequest).postDataJSON().params.task_id, prepare.params.task_id);
  await taskCard.getByText('有限后台：已暂停', { exact: false }).waitFor();
  checks.push('双方加入后单独核对有限worker预算与期限；暂停是实际控制动作，保留原委托');
  await originalChat(page, context, conversation);
  await selectConversation(page, targetConversation);
  await waitDraft(page, '目标会话保留草稿');
  await collaborations(page);
  const sendsBeforeContinuation = writes.filter(call => call.method === 'conversation.send').length;
  await taskCard.getByRole('button', { name: '围绕这件事继续讨论', exact: true }).click();
  await waitDraft(page, '尚未发送的账号草稿\n\n继续讨论事项 ', true);
  assert.equal(await activeConversation(context), conversation);
  assert.equal(writes.filter(call => call.method === 'conversation.send').length, sendsBeforeContinuation, 'continuing a task prepares an original-conversation draft without sending');
  checks.push('从其它主题的事项返回结构化关联原对话，保留原草稿并追加上下文，不自动发送');
  await collaborations(page);
  const taskDelete = taskCard.getByRole('button', { name: '删除 产品方案讨论 的网页记录', exact: true });
  assert.equal(await taskDelete.isDisabled(), true, 'an active cooperative task cannot be deleted');
  const refused = await context.request.post(base + '/api/agents/agent-a1/workspace/records', { headers: { Origin: base }, data: { kind: 'collaboration', id: prepare.params.task_id, deleted: true } });
  assert.equal(refused.status(), 409, 'server independently refuses deletion of nonterminal collaboration');
  assert.equal(await taskCard.count(), 1);
  checks.push('合作进行中删除按钮禁用；直接API同样拒绝，事项仍可见');

  await navigate(page, '联系人');
  await page.getByRole('combobox', { name: '联系人所属 agent', exact: true }).selectOption('agent-a1');
  await page.waitForURL('**/dashboard/contacts?agent=agent-a1');
  const contact = visibleInMain(page, '#subject-product-peer');
  await contact.getByRole('heading', { name: '小林', exact: true }).waitFor();
  const controlBeforeContact = writes.length;
  await contact.getByRole('button', { name: '删除 小林 的网页记录', exact: true }).click();
  await page.getByRole('dialog').getByText('Agent 本机的记录和已发生的操作会保留', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: '删除网页记录', exact: true }).click();
  await contact.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  const persistedContact = await (await context.request.get(base + '/api/agents/agent-a1/workspace')).json();
  assert.equal(persistedContact.snapshots['contacts.list'].data.contacts.some(value => value.contact_id === 'product-peer'), true, 'web delete keeps authenticated agent fact');
  assert.equal(persistedContact.recordStates.some(value => value.kind === 'contact' && value.id === 'product-peer' && value.deleted), true);
  assert.equal(await contact.count(), 0, 're-reading contact facts cannot resurrect a deleted Web row');
  const deletedContacts = page.getByRole('region', { name: '已删除联系人记录', exact: true });
  // The panel is a labelled section, exposed as a region by accessible-name mapping.
  await deletedContacts.getByRole('button', { name: /^已删除记录/ }).click();
  await deletedContacts.getByRole('button', { name: '恢复 小林', exact: true }).click();
  await contact.getByRole('heading', { name: '小林', exact: true }).waitFor();
  assert.equal(writes.slice(controlBeforeContact).some(call => !['contacts.list', 'collaboration.state', 'inbox.list', 'conversation.get'].includes(call.method)), false, 'delete and restore do not perform remote social writes');
  assert.deepEqual(recordWrites.slice(-2), [{ kind: 'contact', id: 'product-peer', deleted: true }, { kind: 'contact', id: 'product-peer', deleted: false }]);
  checks.push('联系人确认删除仅移除Web列表，远端事实保留，刷新不复活；可恢复且不发送社交动作');

  await collaborations(page);
  const closedResponse = await fetch(platform + '/fixture/mode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productCloseTask: prepare.params.task_id, due: true }) });
  assert.equal(closedResponse.ok, true);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await taskCard.getByText('双方已取消约定', { exact: true }).waitFor();
  await taskDelete.waitFor();
  assert.equal(await taskDelete.isEnabled(), true, 'confirmed terminal cooperation can be removed from Web');
  // Exercise the actual stale-parent-cache race: saved record mutations must
  // update the aggregate immediately, even while activity revalidation is held.
  let releaseActivity, heldActivityReads = 0;
  const activityGate = new Promise(resolve => { releaseActivity = resolve; });
  const holdActivity = async route => { heldActivityReads++; await activityGate; await route.continue(); };
  await page.route('**/api/workspace/activity', holdActivity);
  try {
    await taskDelete.click();
    await page.getByRole('dialog').getByRole('button', { name: '删除网页记录', exact: true }).click();
    await taskCard.waitFor({ state: 'hidden' });
    const persistedTask = await (await context.request.get(base + '/api/agents/agent-a1/workspace')).json();
    assert.equal(persistedTask.snapshots['collaboration.state'].data.tasks.some(value => value.task_id === prepare.params.task_id), true, 'web delete keeps agent task history');
    const deletedState = persistedTask.recordStates.find(value => value.kind === 'collaboration' && value.id === prepare.params.task_id && value.deleted);
    assert.ok(deletedState);
    await navigate(page, '合作');
    for (const alias of new Set([prepare.params.task_id, ...(deletedState.relatedIds || [])])) {
      assert.equal(await visibleInMain(page, 'a[href*="subject=' + encodeURIComponent(alias) + '"]').count(), 0, 'aggregate list hides the same task across collaboration aliases');
    }
    const deletedCooperations = page.getByRole('region', { name: '已删除合作记录', exact: true });
    await deletedCooperations.getByRole('button', { name: /^已删除记录/ }).click();
    await deletedCooperations.getByRole('button', { name: '恢复 产品方案讨论', exact: true }).click();
    await visibleInMain(page, 'a[href*="subject=' + prepare.params.task_id + '"]').waitFor();
    assert.ok(heldActivityReads > 0, 'aggregate delete and restore succeed before blocked activity revalidation is released');
  } finally {
    releaseActivity();
    await page.unroute('**/api/workspace/activity', holdActivity);
  }
  await collaborations(page);
  await taskCard.getByText('双方已取消约定', { exact: true }).waitFor();
  checks.push('确认终态合作可删除与恢复；聚合列表/详情按同一别名状态同步，原任务和合成终态证据保留');
  await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await navigate(page, '我的 agents');
    const size = await page.locator('main:visible').evaluate(element => ({ w: innerWidth, d: document.documentElement.scrollWidth, m: element.clientWidth, c: element.scrollWidth }));
    assert.ok(size.d === size.w && size.c <= size.m + 1, JSON.stringify(size));
    assert.equal(await page.getByRole('navigation', { name: '手机主导航', exact: true }).getByRole('link').count(), 4);
    await page.screenshot({ path: path.join(out, 'mobile-' + width + '.png'), fullPage: true });
  }
  assert.deepEqual(errors, []); checks.push('手机320/390无横向溢出且四主入口可达');
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: true, checks, writes: writes.map(call => call.method === 'collaboration.execute' ? call.params.action : call.method), errors, recordWrites }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
}
main().catch(async error => {
  console.error(error.stack);
  if (activePage) { try { await activePage.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, body: await activePage.locator('body').innerText(), writes, metadataWrites, errors, recordWrites, checks }, null, 2)); } catch {} }
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); });
