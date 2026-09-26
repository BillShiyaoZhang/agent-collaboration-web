// PRODUCT_FIXTURE=1, production build, isolated signed Registry/MQ only.
// This regression exercises desktop-first navigation and account-view management.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const base = process.env.WORKSPACE_BROWSER_URL || 'http://127.0.0.1:3062';
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(new URL(base).hostname), 'Only a loopback fixture is permitted');
const out = path.resolve(__dirname, '../../build/desktop-agents-preview');
const checks = [], errors = [], controls = [], metadata = []; let browser, page;
const composer = () => page.getByLabel('给 agent 的消息', { exact: true });
const currentId = () => page.locator('[data-conversation-id]:has(button[aria-current="true"])').first().getAttribute('data-conversation-id');
async function menu(name) { await page.getByLabel('管理对话 ' + name, { exact: true }).click(); }
async function noOverflow() {
  const size = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth, mainWidth: document.querySelector('main').clientWidth, mainScrollWidth: document.querySelector('main').scrollWidth, mainHeight: document.querySelector('main').clientHeight, mainScrollHeight: document.querySelector('main').scrollHeight }));
  assert.equal(size.document, size.width, JSON.stringify(size)); assert.ok(size.mainScrollWidth <= size.mainWidth + 1, JSON.stringify(size)); assert.ok(size.mainScrollHeight <= size.mainHeight + 1, JSON.stringify(size));
}
async function desktopGeometry(width, height) {
  await page.setViewportSize({ width, height });
  await noOverflow();
  const list = await page.getByLabel('agent 和聊天列表', { exact: true }).boundingBox();
  const chat = await page.getByLabel('聊天框', { exact: true }).boundingBox();
  const box = await composer().boundingBox(), transcript = await page.getByLabel('对话记录', { exact: true }).boundingBox();
  assert.ok(list && chat && box && transcript); assert.equal(Math.round(list.width), 264); assert.ok(list.x + list.width <= chat.x + 1);
  assert.ok(transcript.height >= height * 0.4, JSON.stringify({ width, height, transcript, box }));
  assert.ok(box.y + box.height <= height && box.y > height * 0.65, JSON.stringify({ width, height, box }));
  const oldPanel = page.getByRole('tablist', { name: '工作台功能', exact: true }); assert.equal(await oldPanel.count(), 0);
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  for (const name of ['results.json', 'failure.json', 'failure.png']) { const artifact = path.join(out, name); if (fs.existsSync(artifact)) fs.unlinkSync(artifact); }
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, timezoneId: 'Asia/Shanghai' });
  page = await context.newPage(); page.setDefaultTimeout(30000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/control')) controls.push(request.postDataJSON()); if (request.method() === 'POST' && request.url().endsWith('/workspace/conversations')) metadata.push(request.postDataJSON()); });
  await page.goto(base + '/login'); await page.getByLabel('邮箱', { exact: true }).fill('owner-a@workspace.invalid'); await page.getByLabel('密码', { exact: true }).fill('Workspace-smoke-fixture-2026'); await page.getByRole('button', { name: '进入工作空间', exact: true }).click(); await page.waitForURL('**/dashboard/chats');
  await composer().waitFor(); assert.equal(await composer().isEnabled(), true); assert.equal(controls.filter(call => call.method === 'conversation.send').length, 0);
  await desktopGeometry(1440, 900); await desktopGeometry(1366, 768); checks.push('默认直接显示聊天框，1440×900/1366×768三栏布局，全局不滚动，输入固定底部');
  // The default chooses the most recently saved agent. Explicitly select A1 for deterministic fixtures.
  await page.getByRole('button', { name: '与 同步测试 A1 聊天', exact: true }).click(); await page.getByRole('region', { name: '与 同步测试 A1 对话', exact: true }).waitFor();
  await page.getByRole('button', { name: '新对话', exact: true }).click(); await composer().fill('桌面三栏真实聊天'); await page.getByLabel('发送消息', { exact: true }).click();
  await page.getByLabel('对话记录', { exact: true }).getByText('这是自动同步回来的回复', { exact: true }).waitFor({ timeout: 120000 });
  await page.locator('[data-conversation-id]:has(button[aria-current="true"])').first().waitFor(); const id = await currentId(); assert.ok(id);
  const originalTitle = await page.locator(`[data-conversation-id="${id}"]`).getByRole('button').first().getAttribute('aria-label'); const title = originalTitle.slice('打开对话 '.length);
  await composer().fill('桌面列表保留的草稿');
  await menu(title); await page.getByRole('menuitem', { name: '重命名', exact: true }).click(); await page.getByLabel('对话标题', { exact: true }).fill('桌面验收主题'); await page.getByRole('button', { name: '保存名称', exact: true }).click();
  await page.getByRole('button', { name: '打开对话 桌面验收主题', exact: true }).waitFor(); await menu('桌面验收主题'); await page.getByRole('menuitem', { name: '归档对话', exact: true }).click(); await page.getByRole('button', { name: '归档', exact: true }).click(); await page.getByRole('button', { name: '打开对话 桌面验收主题', exact: true }).waitFor();
  await menu('桌面验收主题'); await page.getByRole('menuitem', { name: '取消归档', exact: true }).click(); await page.getByRole('button', { name: '对话', exact: true }).click(); await page.getByRole('button', { name: '打开对话 桌面验收主题', exact: true }).waitFor();
  assert.equal(await composer().inputValue(), '桌面列表保留的草稿'); checks.push('左列表更多菜单重命名、归档/取消归档，不挤占聊天，也不丢当前草稿');
  await page.getByLabel('搜索已保存对话', { exact: true }).fill('桌面三栏真实聊天'); await page.getByRole('button', { name: '打开对话 桌面验收主题', exact: true }).waitFor(); await page.getByLabel('搜索已保存对话', { exact: true }).fill('');
  const sendsBeforeDelete = controls.filter(call => call.method === 'conversation.send').length;
  await menu('桌面验收主题'); await page.getByRole('menuitem', { name: '删除对话', exact: true }).click(); await page.getByRole('dialog').getByText('可以恢复。', { exact: false }).waitFor(); await page.getByRole('button', { name: '确认删除', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('textarea[aria-label="给 agent 的消息"]')?.value === '');
  await page.waitForTimeout(4500); assert.equal(await page.getByRole('button', { name: '打开对话 桌面验收主题', exact: true }).count(), 0); assert.equal(controls.filter(call => call.method === 'conversation.send').length, sendsBeforeDelete);
  await page.getByRole('button', { name: '已删除', exact: true }).click(); await page.getByLabel('管理对话 桌面验收主题', { exact: true }).waitFor(); await menu('桌面验收主题'); await page.getByRole('menuitem', { name: '恢复对话', exact: true }).click(); await page.getByRole('button', { name: '对话', exact: true }).click(); await page.getByRole('button', { name: '打开对话 桌面验收主题', exact: true }).click();
  await page.getByLabel('对话记录', { exact: true }).getByText('桌面三栏真实聊天', { exact: true }).waitFor(); assert.equal(await composer().inputValue(), '桌面列表保留的草稿'); checks.push('删除当前主题安全切到空聊天，后台同步不复活；恢复原记录和草稿，不自动重发');
  const pendingDraft = '切换 agent 之前即时输入的草稿'; await composer().fill(pendingDraft); await page.getByRole('button', { name: '与 同步测试 A2 聊天', exact: true }).click(); await page.getByRole('region', { name: '与 同步测试 A2 对话', exact: true }).waitFor(); const resumed = page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/api/agents/agent-a1/workspace') && new URL(response.url()).searchParams.get('conversation_id') === id); await page.getByRole('button', { name: '与 同步测试 A1 聊天', exact: true }).click(); assert.equal((await (await resumed).json()).activeConversationId, id); await page.waitForFunction(value => document.querySelector('textarea[aria-label="给 agent 的消息"]')?.value === value, pendingDraft); await page.locator(`[data-conversation-id="${id}"]:has(button[aria-current="true"])`).waitFor(); await page.getByLabel('对话记录', { exact: true }).getByText('桌面三栏真实聊天', { exact: true }).waitFor(); checks.push('左侧切换自己的agent，700ms前未发送草稿保留，不新增远程写动作');
  await page.getByLabel('管理 agent 同步测试 A1', { exact: true }).click(); await page.getByRole('menuitem', { name: '重命名', exact: true }).click(); await page.getByLabel('agent 名称', { exact: true }).fill('我的桌面助理'); await page.getByRole('button', { name: '保存名称', exact: true }).click(); await page.getByRole('button', { name: '与 我的桌面助理 聊天', exact: true }).waitFor(); checks.push('已连接agent提供重命名菜单，更新仅属于本账户名称');
  // The following policy/unknown-submission responses are DOM layout fixtures only.
  // They never confirm policy or submit business actions, and do not validate policy semantics.
  const policyPage = await context.newPage(); const policyControls = [];
  policyPage.on('pageerror', error => errors.push(error.message));
  await policyPage.route('**/api/platform-policy', route => route.request().method() === 'GET' ? route.fulfill({ json: { status: 'signed', mode: 'compliance', epoch: 3, platform_id: 'urn:fixture:layout', policy_hash: 'a'.repeat(64), gateway_key_id: 'fixture-layout-key', confirmed: false, paused: false, can_use_workbench: false } }) : route.abort());
  await policyPage.route('**/api/agents/agent-a1/workspace?*', async route => {
    const response = await route.fetch(), data = await response.json(), conversationId = data.activeConversationId || 'fixture-layout-only';
    data.submission = { call: { request_id: '01234567-89ab-4cde-8f01-23456789abcd', method: 'conversation.send', params: { conversation_id: conversationId, text: '布局测试未知发送' }, created_at: Date.now() - 300000 }, conversationId, turnId: 'fixture-layout-only-turn', text: '布局测试未知发送', phase: 'uncertain', retryable: false };
    await route.fulfill({ response, json: data });
  });
  policyPage.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/control')) policyControls.push(request.postDataJSON()); });
  await policyPage.goto(base + '/dashboard/chats?agent=agent-a1'); await policyPage.getByRole('heading', { name: '请确认平台政策', exact: true }).waitFor(); await policyPage.getByRole('button', { name: '保留记录并继续', exact: true }).waitFor();
  const policyBounds = [];
  for (const height of [844, 640]) {
    await policyPage.setViewportSize({ width: 320, height });
    const bounds = await policyPage.evaluate(() => { const rect = element => { const value = element.getBoundingClientRect(); return { top: value.top, bottom: value.bottom, height: value.height }; }; return { height: innerHeight, policy: rect(document.querySelector('section[aria-label="平台政策与内容可见范围"]')), composer: rect(document.querySelector('textarea[aria-label="给 agent 的消息"]')), send: rect(document.querySelector('button[aria-label="发送消息"]')), chat: rect(document.querySelector('section[aria-label="聊天框"]')), width: innerWidth, documentWidth: document.documentElement.scrollWidth }; });
    policyBounds.push(bounds); await policyPage.screenshot({ path: path.join(out, `mobile-policy-unknown-320x${height}.png`), fullPage: true });
    fs.writeFileSync(path.join(out, 'mobile-policy-layout.json'), JSON.stringify({ passed: false, syntheticDOMLayoutOnly: true, bounds: policyBounds, businessWrites: policyControls.length }, null, 2));
    assert.equal(bounds.documentWidth, bounds.width); assert.ok(bounds.composer.top >= bounds.chat.top && bounds.composer.bottom <= bounds.chat.bottom + 1, JSON.stringify(bounds)); assert.ok(bounds.send.bottom <= bounds.chat.bottom + 1, JSON.stringify(bounds));
  }
  assert.equal(policyControls.length, 0); fs.writeFileSync(path.join(out, 'mobile-policy-layout.json'), JSON.stringify({ passed: true, syntheticDOMLayoutOnly: true, bounds: policyBounds, businessWrites: 0 }, null, 2)); await policyPage.close();
  checks.push('仅合成DOM布局：320×844/640展开阻断政策与未知发送同时显示，输入和按钮可见，不确认政策或发送业务');
  await page.screenshot({ path: path.join(out, 'desktop-1366.png'), fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 }); await noOverflow(); assert.equal(await composer().isVisible(), true);
    await page.getByRole('button', { name: 'agent 与聊天列表', exact: true }).click(); await page.getByLabel('agent 和聊天列表', { exact: true }).waitFor(); await page.getByRole('button', { name: '与 同步测试 A2 聊天', exact: true }).click(); await page.getByRole('region', { name: '与 同步测试 A2 对话', exact: true }).waitFor(); assert.equal(await page.getByLabel('agent 和聊天列表', { exact: true }).isVisible(), false); await noOverflow();
    await page.screenshot({ path: path.join(out, `mobile-${width}.png`), fullPage: true });
  }
  checks.push('390/320px手机优先显示聊天，列表抽屉选agent后收起，无横向或整页溢出');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByLabel('管理 agent 同步测试 A2', { exact: true }).click(); await page.getByRole('menuitem', { name: '删除连接', exact: true }).click(); await page.getByRole('dialog').getByText('Agent 本机数据与配对保留', { exact: false }).waitFor(); const removal = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().endsWith('/api/agents/agent-a2')); await page.getByRole('button', { name: '确认删除连接', exact: true }).click(); assert.equal((await removal).status(), 200); await page.getByRole('button', { name: '与 同步测试 A2 聊天', exact: true }).waitFor({ state: 'detached' }); await page.getByRole('button', { name: '与 我的桌面助理 聊天', exact: true }).waitFor(); await page.waitForTimeout(4500); assert.equal(await page.getByRole('button', { name: '与 同步测试 A2 聊天', exact: true }).count(), 0); checks.push('删除连接先明确Web副本范围，剩余agent直接可聊天，不删除agent本机身份');
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ passed: true, checks, errors, controlMethods: controls.map(call => call.method), metadataWrites: metadata.length }, null, 2)); console.log(JSON.stringify({ passed: true, checks }));
}
main().catch(async error => { console.error(error.stack); if (page) { try { await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); fs.writeFileSync(path.join(out, 'failure.json'), JSON.stringify({ error: error.message, body: await page.locator('body').innerText(), composer: await composer().inputValue().catch(() => null), activeConversation: await currentId().catch(() => null), errors, controlMethods: controls.map(call => call.method) }, null, 2)); } catch {} } process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); });
