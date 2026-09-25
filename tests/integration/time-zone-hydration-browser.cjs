// Build Web, start the loopback fixture with TZ=UTC and either ATTENTION_FIXTURE=1
// or SOCIAL_FIXTURE=1, then run this script with the same flags. See tests/README.md.
// Verifies real Next SSR hydration against browsers in two different time zones.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');

const base = 'http://127.0.0.1:3062';
assert.equal(Intl.DateTimeFormat().resolvedOptions().timeZone, 'UTC', 'run this check with TZ=UTC');
const socialMode = process.env.SOCIAL_FIXTURE === '1';
assert.ok(socialMode || process.env.ATTENTION_FIXTURE === '1', 'run with a social or attention fixture');
const compactOptions = { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
let browser;

async function inspect(timezoneId) {
  const context = await browser.newContext({ timezoneId });
  const page = await context.newPage();
  const hydrationErrors = [], pageErrors = [];
  const collect = text => {
    if (/Hydration failed|Minified React error #418|server rendered HTML|Text content does not match/i.test(text)) hydrationErrors.push(text);
  };
  page.on('pageerror', error => { pageErrors.push(error.message); collect(error.message); });
  page.on('console', message => { if (message.type() === 'error') collect(message.text()); });
  try {
    await page.goto(`${base}/login`);
    await page.getByLabel('邮箱', { exact: true }).fill('owner-a@workspace.invalid');
    await page.getByLabel('密码', { exact: true }).fill('Workspace-smoke-fixture-2026');
    await page.getByRole('button', { name: '进入工作空间', exact: true }).click();
    await page.waitForURL('**/dashboard/agents');
    const workspace = await (await context.request.get(`${base}/api/workspace`)).json();
    const agent = workspace.connections.find(connection => connection.name === '同步测试 A1');
    assert.ok(agent?.sync?.lastSuccessAt, 'fixture must supply an SSR-visible saved sync time');
    const agentData = async () => (await (await context.request.get(`${base}/api/agents/${agent.id}/workspace`)).json());
    const initialAgent = await agentData();
    assert.ok(initialAgent.snapshots['collaboration.state']?.time, 'fixture must supply a saved collaboration snapshot');
    const browserTime = timestamp => page.evaluate(({ timestamp, options }) =>
      new Date(timestamp).toLocaleString('zh-CN', options),
    { timestamp, options: compactOptions });

    // A hard navigation is essential: SPA navigation would not hydrate server HTML.
    const response = await page.goto(`${base}/dashboard/agents`, { waitUntil: 'domcontentloaded' });
    assert.ok((await response.text()).includes('本地时间加载中…'), 'SSR must contain a stable placeholder');
    const card = page.getByRole('link', { name: '打开 同步测试 A1 的远程工作台', exact: true });
    const expected = await browserTime(agent.sync.lastSuccessAt);
    await card.getByText(`最近同步 ${expected}`, { exact: true }).waitFor();
    assert.equal(await card.getByText('本地时间加载中…').count(), 0);
    assert.deepEqual(hydrationErrors, [], `${timezoneId} dashboard hydration`);

    let messageTime = null;
    if (socialMode) {
      const incoming = initialAgent.snapshots['inbox.list']?.data?.messages?.find(message => message.message_id === 'social-message');
      assert.ok(incoming?.received_at, 'social fixture must supply an SSR-visible received time');
      const inbox = await page.goto(`${base}/dashboard/agents/${agent.id}?tab=inbox`, { waitUntil: 'domcontentloaded' });
      const inboxHtml = await inbox.text();
      const messageArticle = inboxHtml.match(/<article\b(?=[^>]*\bid="subject-social-message")[^>]*>([\s\S]*?)<\/article>/);
      assert.ok(messageArticle, 'received message must be present in server HTML');
      assert.ok(messageArticle[1].includes('本地时间加载中…'), 'received message SSR must use the stable placeholder');
      const message = page.locator('#subject-social-message');
      messageTime = await browserTime(incoming.received_at * 1000);
      await message.locator('time').getByText(messageTime, { exact: true }).waitFor();
      assert.deepEqual(pageErrors, [], `${timezoneId} inbox page errors`);
      assert.deepEqual(hydrationErrors, [], `${timezoneId} inbox hydration`);
    } else {
      const workbench = await page.goto(`${base}/dashboard/agents/${agent.id}?tab=tasks`, { waitUntil: 'domcontentloaded' });
      assert.ok((await workbench.text()).includes('本地时间加载中…'), 'workbench SSR must use the same placeholder');
      await page.getByRole('tab', { name: '事项', exact: true }).waitFor();
      await page.getByText('项目方案讨论', { exact: true }).first().waitFor();
      const latestAgent = await agentData();
      const taskTimes = await Promise.all([initialAgent, latestAgent].map(saved => browserTime(saved.snapshots['collaboration.state'].time)));
      const shownTaskTime = await page.locator('[role="tabpanel"] p').filter({ hasText: /^已保存 · 最近同步/ }).first().textContent();
      assert.ok(taskTimes.some(time => shownTaskTime === `已保存 · 最近同步 ${time}`), `task snapshot time must be local: ${shownTaskTime}`);
      assert.deepEqual(hydrationErrors, [], `${timezoneId} workbench hydration`);
    }

    const notices = await (await context.request.get(`${base}/api/notifications`)).json();
    assert.ok(notices.items.length, 'attention fixture must supply reminders');
    const item = notices.items[0];
    await page.goto(`${base}/dashboard/notifications`, { waitUntil: 'domcontentloaded' });
    const reminder = page.locator('article').filter({ has: page.getByRole('heading', { name: item.title, exact: true }) }).first();
    await reminder.waitFor();
    const observed = await browserTime(item.observedAt);
    await reminder.getByText(new RegExp(`最近同步 ${observed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)).waitFor();
    assert.equal(await reminder.getByText('本地时间加载中…').count(), 0);
    assert.deepEqual(pageErrors, [], `${timezoneId} page errors`);
    assert.deepEqual(hydrationErrors, [], `${timezoneId} reminders hydration`);
    return { timezoneId, dashboardTime: expected, messageTime, reminderTime: observed };
  } finally {
    await context.close();
  }
}

(async () => {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const utc = await inspect('UTC');
  const shanghai = await inspect('Asia/Shanghai');
  assert.notEqual(utc.dashboardTime, shanghai.dashboardTime, 'display must follow the reader’s time zone');
  if (socialMode) assert.notEqual(utc.messageTime, shanghai.messageTime, 'inbox time must follow the reader’s time zone');
  assert.notEqual(utc.reminderTime, shanghai.reminderTime, 'reminder time must follow the reader’s time zone');
  console.log(JSON.stringify({ passed: 3, fixture: socialMode ? 'social' : 'attention', utc, shanghai, hydrationErrors: 0, pageErrors: 0 }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
