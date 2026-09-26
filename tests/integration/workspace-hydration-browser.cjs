// Fresh PRODUCT_FIXTURE=1 and a production Next build; loopback synthetic data only.
// Hold initial dashboard JS so SSR controls must protect a real first click/fill.
// Release JS and let that SAME pending action finish: no retry or React-props wait.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const base = 'http://127.0.0.1:3062';
const out = path.resolve(__dirname, '../../build/workspace-sync-preview/hydration-readiness');
const report = { origin: base, startedAt: new Date().toISOString(), cases: [], pageErrors: [], businessWritesAllowed: 0 };
let browser;

function controlState(element) {
  return {
    disabled: element.matches(':disabled'), ownDisabled: !!element.disabled,
    inert: !!element.closest('[inert]'),
    value: 'value' in element ? element.value : undefined,
    pressed: element.getAttribute('aria-pressed'), readyState: document.readyState,
  };
}
async function fence(context, allowLogin = false) {
  let loginPosts = 0;
  const counters = { blockedBusinessWrites: 0 };
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    assert.equal(url.origin, base, 'the regression only contacts the loopback fixture');
    if (allowLogin && url.pathname === '/api/auth/callback/credentials' && request.method() === 'POST' && loginPosts === 0) {
      loginPosts++; await route.continue(); return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) {
      counters.blockedBusinessWrites++;
      await route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"Readiness regression blocks business mutations."}' });
    } else await route.continue();
  });
  return counters;
}
async function readyCase(cookies, specification) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', storageState: { cookies, origins: [] } });
  const counters = await fence(context);
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  page.on('pageerror', error => report.pageErrors.push({ name: error.name, message: error.message }));
  let releaseJS, heldScripts = 0;
  const gate = new Promise(resolve => { releaseJS = resolve; });
  await page.route('**/_next/**/*.js', async route => { heldScripts++; await gate; await route.continue(); });
  try {
    await page.goto(base + specification.route, { waitUntil: 'commit' });
    const control = page.locator(specification.selector + ':visible');
    await control.waitFor();
    const before = await control.evaluate(controlState);
    assert.ok(heldScripts > 0, 'initial dashboard JavaScript is actually held');
    assert.ok(before.disabled || before.inert, 'SSR control is protected until its component is interactive');
    if (specification.kind === 'click') assert.equal(before.pressed, 'false');
    else assert.equal(before.value, '');
    const result = { name: specification.name, before, heldScriptsBeforeRelease: heldScripts, actionCalls: 1 };
    report.cases.push(result);
    let settled = false;
    // Start the real action now. Playwright must wait for disabled/inert protection
    // to lift; we never run a second click/fill after hydration.
    const action = (specification.kind === 'click' ? control.click() : control.fill(specification.value)).then(() => { settled = true; });
    await page.waitForTimeout(150);
    result.actionSettledWhileJSHeld = settled;
    result.whileHeld = await control.evaluate(controlState);
    assert.equal(settled, false, 'the first native action remains pending while JS is held');
    if (specification.kind === 'click') assert.equal(result.whileHeld.pressed, 'false');
    else assert.equal(result.whileHeld.value, '');
    releaseJS();
    await action;
    if (specification.kind === 'click') {
      await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute('aria-pressed') === 'true', specification.selector);
    } else if (specification.name === 'saved-chat-search') {
      await page.locator('main:visible').getByText('没有找到已保存记录。', { exact: true }).waitFor();
      assert.equal(await page.locator('main:visible [data-conversation-id]:visible').count(), 0);
    } else {
      const send = page.getByRole('button', { name: '发送消息', exact: true });
      await page.waitForFunction(() => !document.querySelector('button[aria-label="发送消息"]')?.matches(':disabled'));
      assert.equal(await send.isEnabled(), true, 'composer input updated React state; it was never sent');
    }
    result.after = await control.evaluate(controlState);
    assert.equal(result.after.disabled, false); assert.equal(result.after.inert, false);
    if (specification.kind === 'click') assert.equal(result.after.pressed, 'true');
    else assert.equal(result.after.value, specification.value);
    result.blockedBusinessWrites = counters.blockedBusinessWrites;
    console.log(JSON.stringify(result));
  } finally {
    releaseJS(); await page.unrouteAll({ behavior: 'wait' }); await context.close();
  }
}
async function main() {
  fs.mkdirSync(out, { recursive: true });
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const login = await browser.newContext({ serviceWorkers: 'block' }); await fence(login, true);
  const page = await login.newPage();
  await page.goto(base + '/login'); await page.getByLabel('邮箱', { exact: true }).fill('owner-a@workspace.invalid');
  await page.getByLabel('密码', { exact: true }).fill('Workspace-smoke-fixture-2026');
  await page.getByRole('button', { name: '进入工作空间', exact: true }).click(); await page.waitForURL('**/dashboard/chats');
  const cookies = await login.cookies(); await login.close();
  for (const specification of [
    { name: 'cooperation-filter', route: '/dashboard/collaborations', selector: '[aria-label="协作筛选"] button:nth-child(2)', kind: 'click' },
    { name: 'saved-chat-search', route: '/dashboard/chats?agent=agent-a1', selector: 'input[aria-label="搜索已保存对话"]', kind: 'fill', value: 'hydration-no-match-regression' },
    { name: 'native-chat-composer', route: '/dashboard/chats?agent=agent-a1', selector: 'textarea[aria-label="给 agent 的消息"]', kind: 'fill', value: '一次待输入的 hydration 回归草稿' },
  ]) await readyCase(cookies, specification);
  assert.deepEqual(report.pageErrors, []); report.passed = true;
}
main().catch(error => { report.passed = false; report.failure = { name: error.name, message: error.message }; console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  await browser?.close(); report.finishedAt = new Date().toISOString(); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
});
