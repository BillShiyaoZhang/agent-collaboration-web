// Fresh PRODUCT_FIXTURE=1, built Web and synthetic signed-MQ identities only.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const base = 'http://127.0.0.1:3062', platform = 'http://127.0.0.1:3061', out = path.resolve(__dirname, '../../build/workspace-sync-preview/product');
const checks = [], errors = [], writes = [], metadataWrites = []; let browser, activePage;
const isControl = (request, method, action) => request.method() === 'POST' && request.url().endsWith('/control') && request.postDataJSON().method === method && (!action || request.postDataJSON().params.action === action);

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
  });
  await page.goto(base + '/login'); await page.getByLabel('邮箱', { exact: true }).fill('owner-a@workspace.invalid');
  await page.getByLabel('密码', { exact: true }).fill('Workspace-smoke-fixture-2026');
  await page.getByRole('button', { name: '进入工作空间', exact: true }).click(); await page.waitForURL('**/dashboard/chats');
  assert.equal(writes.length, 0); await page.locator('a[href="/dashboard/agents/agent-a1?tab=conversation"]').first().click();
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  const composer = page.getByLabel('给 agent 的消息', { exact: true });
  await composer.fill('产品旅程原始消息'); await page.getByLabel('发送消息', { exact: true }).click();
  await page.getByLabel('对话记录', { exact: true }).getByText('这是自动同步回来的回复', { exact: true }).waitFor({ timeout: 120000 });
  assert.equal(await page.getByLabel('对话记录', { exact: true }).locator('table').count(), 1);
  checks.push('默认聊天入口，真实回执后保存格式化答复');
  const conversation = await page.getByLabel('选择历史对话', { exact: true }).inputValue();
  await composer.fill('尚未发送的账号草稿'); await page.waitForTimeout(1100);
  await page.getByLabel('对话设置', { exact: true }).click(); await page.getByLabel('对话标题', { exact: true }).fill('产品讨论主题');
  await page.getByRole('button', { name: '保存标题', exact: true }).click();
  await page.getByLabel('搜索已保存对话', { exact: true }).fill('产品旅程原始消息');
  await page.getByRole('button', { name: '产品讨论主题', exact: false }).waitFor();
  await page.getByRole('button', { name: '归档主题', exact: true }).click(); await page.getByRole('button', { name: '查看归档', exact: true }).click();
  await page.getByRole('button', { name: '产品讨论主题', exact: false }).waitFor(); checks.push('标题、搜索与归档保存到账户，原记录可恢复');
  await page.reload(); assert.equal(await composer.inputValue(), '尚未发送的账号草稿'); checks.push('刷新恢复账号草稿和原对话');

  // Create a second real fixture conversation, then inject a selection delay past the draft debounce.
  const unarchive = await context.request.post(base + '/api/agents/agent-a1/workspace/conversations', { headers: { Origin: base }, data: { conversationId: conversation, archived: false } }); assert.equal(unarchive.ok(), true);
  await page.getByRole('button', { name: '新对话', exact: true }).click();
  await composer.fill('竞态第二个会话'); await page.getByLabel('发送消息', { exact: true }).click();
  await page.getByLabel('对话记录', { exact: true }).getByText('这是自动同步回来的回复', { exact: true }).waitFor({ timeout: 120000 });
  const targetConversation = await page.getByLabel('选择历史对话', { exact: true }).inputValue();
  const savedDraft = page.waitForRequest(request => /\/workspace\/conversations$/.test(request.url()) && request.method() === 'POST' && request.postDataJSON().draft === '目标会话保留草稿');
  await composer.fill('目标会话保留草稿'); await savedDraft;
  await page.getByLabel('选择历史对话', { exact: true }).selectOption(conversation);
  await composer.waitFor();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="给 agent 的消息"]')?.value === '尚未发送的账号草稿');
  const start = metadataWrites.length;
  await page.route('**/api/agents/agent-a1/workspace', async route => {
    const request = route.request();
    if (request.method() === 'POST' && request.postDataJSON().action === 'select_conversation' && request.postDataJSON().conversationId === targetConversation) await new Promise(resolve => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.getByLabel('选择历史对话', { exact: true }).selectOption(targetConversation);
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="给 agent 的消息"]')?.value === '目标会话保留草稿');
  assert.equal(metadataWrites.slice(start).some(patch => patch.conversationId === targetConversation && patch.draft === ''), false, 'slow selection cannot overwrite the unloaded target draft');
  await page.unroute('**/api/agents/agent-a1/workspace');
  await page.getByLabel('选择历史对话', { exact: true }).selectOption(conversation);
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="给 agent 的消息"]')?.value === '尚未发送的账号草稿');
  checks.push('会话选择延迟超过700ms，不向未加载目标写空草稿，两段草稿均保留');

  await page.getByRole('tab', { name: '事项', exact: true }).click();
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

  await page.getByRole('button', { name: '发起协作', exact: true }).click();
  await page.getByLabel('合作对象', { exact: true }).selectOption('product-peer');
  await page.getByLabel('合作目标', { exact: true }).fill('与小林确定产品讨论时间');
  await page.getByLabel('成功标准', { exact: true }).fill('双方同步确认三十分钟会议约定');
  await page.getByLabel('对外会议主题', { exact: true }).fill('产品方案讨论');
  await page.getByLabel('时段 1 开始时间', { exact: true }).fill('2030-01-10T14:00');
  await page.getByLabel('时段 1 结束时间', { exact: true }).fill('2030-01-10T17:00');
  await page.getByLabel('授权截止时间', { exact: true }).fill('2030-01-09T18:00');
  const preparedRequest = page.waitForRequest(request => isControl(request, 'collaboration.execute', 'prepare_task'));
  await page.getByRole('button', { name: '生成确切委托授权问题', exact: true }).click();
  const prepare = (await preparedRequest).postDataJSON();
  await page.locator('#subject-approval-' + prepare.params.task_id).getByText('确切委托范围：', { exact: false }).waitFor();
  assert.equal(prepare.params.source_conversation_id, conversation); assert.deepEqual(prepare.params.scope.recipient_ids, ['product-peer']);
  assert.equal(writes.filter(call => call.params.action === 'dispatch').length, 0);
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await page.getByRole('heading', { name: '这段对话关联的当前事项', exact: true }).waitFor();
  const taskApproval = page.locator('#subject-approval-' + prepare.params.task_id);
  const taskDecision = page.waitForRequest(request => isControl(request, 'approval.respond') && request.postDataJSON().params.approval_id === 'approval-' + prepare.params.task_id);
  await taskApproval.getByRole('button', { name: '同意本次请求', exact: true }).click(); await taskDecision;
  await page.getByText('委托已授权，尚未邀请或加入', { exact: true }).waitFor();
  checks.push('表单无需ID/JSON；仅确切审批授权，原聊天显示同一事项');
  await page.getByRole('tab', { name: '事项', exact: true }).click();
  const taskCard = page.locator('#subject-' + prepare.params.task_id);
  const invitationRequest = page.waitForRequest(request => isControl(request, 'collaboration.execute', 'prepare_collaboration'));
  await taskCard.getByRole('button', { name: '生成确切邀请授权问题', exact: true }).click();
  const invitation = (await invitationRequest).postDataJSON();
  const invitationApproval = page.locator('#subject-approval-' + invitation.params.operation_id);
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
  const workerApproval = page.locator('#subject-approval-worker-' + prepare.params.task_id);
  await workerApproval.getByRole('button', { name: '同意本次请求', exact: true }).click();
  await taskCard.getByRole('button', { name: '暂停后台运行', exact: true }).click();
  const pauseRequest = page.waitForRequest(request => isControl(request, 'collaboration.execute', 'pause_worker'));
  await taskCard.getByRole('button', { name: '确认执行本次操作', exact: true }).click();
  assert.equal((await pauseRequest).postDataJSON().params.task_id, prepare.params.task_id);
  await taskCard.getByText('有限后台：已暂停', { exact: false }).waitFor();
  checks.push('双方加入后单独核对有限worker预算与期限；暂停是实际控制动作，保留原委托');
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await page.getByLabel('选择历史对话', { exact: true }).selectOption(targetConversation);
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="给 agent 的消息"]')?.value === '目标会话保留草稿');
  await page.getByRole('tab', { name: '事项', exact: true }).click();
  const sendsBeforeContinuation = writes.filter(call => call.method === 'conversation.send').length;
  await taskCard.getByRole('button', { name: '围绕这件事继续讨论', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="给 agent 的消息"]')?.value.startsWith('尚未发送的账号草稿\n\n继续讨论事项 '));
  assert.equal(await page.getByLabel('选择历史对话', { exact: true }).inputValue(), conversation);
  assert.equal(writes.filter(call => call.method === 'conversation.send').length, sendsBeforeContinuation, 'continuing a task prepares an original-conversation draft without sending');
  checks.push('从其它主题的事项返回结构化关联原对话，保留原草稿并追加上下文，不自动发送');
  await page.getByRole('tab', { name: '事项', exact: true }).click();
  await page.screenshot({ path: path.join(out, 'desktop.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await page.getByRole('tab', { name: '对话', exact: true }).click();
    const size = await page.evaluate(() => ({ w: innerWidth, d: document.documentElement.scrollWidth, m: document.querySelector('main').clientWidth, c: document.querySelector('main').scrollWidth }));
    assert.ok(size.d === size.w && size.c <= size.m + 1, JSON.stringify(size));
    assert.equal(await page.getByRole('navigation', { name: '手机主导航', exact: true }).getByRole('link').count(), 4);
    await page.screenshot({ path: path.join(out, 'mobile-' + width + '.png'), fullPage: true });
  }
  assert.deepEqual(errors, []); checks.push('手机320/390无横向溢出且四主入口可达');
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: true, checks, writes: writes.map(call => call.method === 'collaboration.execute' ? call.params.action : call.method), errors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks }));
}
main().catch(async error => {
  console.error(error.stack);
  if (activePage) { try { await activePage.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, body: await activePage.locator('body').innerText(), writes, metadataWrites, errors }, null, 2)); } catch {} }
  process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); });
