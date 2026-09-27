// Production build + loopback workspace-fixture.cjs only. No real accounts or Agents.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const base = process.env.WORKSPACE_BROWSER_URL || 'http://127.0.0.1:3062';
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname), 'Only a loopback fixture is permitted');
const out = path.resolve(__dirname, '../../build/agent-sharing-preview');
const calls = [], errors = [], checks = []; let browser, page;
const sendCount = () => calls.filter(call => call.method === 'conversation.send').length;
const composer = () => page.getByRole('textbox', { name: '给 agent 的消息', exact: true });
const send = () => page.getByRole('button', { name: '发送消息', exact: true });
const history = () => page.locator('[aria-label="对话记录"]:visible');
const dialog = () => page.getByRole('dialog');
async function manage() { await page.getByRole('button', { name: /^管理共享许可，/ }).first().click(); await page.getByRole('heading', { name: '管理内容共享许可', exact: true }).waitFor(); }
async function approve() { await dialog().getByRole('button', { name: '同意共享并返回', exact: true }).click(); await dialog().waitFor({ state: 'hidden' }); }
async function login(request) {
 const csrf = await (await request.get(base + '/api/auth/csrf')).json();
 const response = await request.post(base + '/api/auth/callback/credentials', { form: { csrfToken: csrf.csrfToken, email: 'owner-a@workspace.invalid', password: 'Workspace-smoke-fixture-2026', json: 'true', callbackUrl: base + '/dashboard/chats' } });
 assert.equal(response.status(), 200);
}
async function main() {
 fs.mkdirSync(out, { recursive: true });
 browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
 const publicContext = await browser.newContext({ viewport: { width: 320, height: 844 }, ignoreHTTPSErrors: new URL(base).protocol === 'https:' });
 const publicPage = await publicContext.newPage(); publicPage.on('pageerror', error => errors.push(error.message));
 await publicPage.goto(base + '/community'); assert.equal(new URL(publicPage.url()).pathname, '/community');
 for(const language of ['zh','en']) {
  await publicPage.getByRole('button', { name: language === 'en' ? 'EN' : '中文', exact:true }).click();
  await publicPage.getByRole('heading', { name: language === 'en' ? 'Content standards' : '内容规范', exact:true }).waitFor();
  for(const width of [320,768,1366]) { await publicPage.setViewportSize({width,height:844}); assert.equal(await publicPage.evaluate(()=>document.documentElement.scrollWidth),width); }
  await publicPage.getByRole('link', { name: language === 'en' ? 'Skip to content' : '跳到主要内容', exact:true }).focus(); await publicPage.keyboard.press('Enter');
  assert.equal(await publicPage.evaluate(()=>document.activeElement.id),'main');
  await publicPage.getByRole('navigation', { name: language === 'en' ? 'Contents' : '内容目录', exact:true }).getByRole('link', { name: language === 'en' ? 'Review on the website before app display' : '先在网站审核，再在 App 显示', exact:true }).click();
  assert.equal(await publicPage.evaluate(()=>document.activeElement.id),'review');
  assert.equal(await publicPage.getByRole('link', { name: language === 'en' ? 'Review pending content' : '审核待审内容', exact:true }).getAttribute('href'),'/dashboard/content-review');
 }
 await publicPage.setViewportSize({width:320,height:844}); await publicPage.goto(base+'/community'); await publicPage.getByRole('heading',{name:'Content standards',exact:true}).waitFor(); await publicPage.screenshot({path:path.join(out,'community-en-320.png'),fullPage:true}); await publicContext.close();
 checks.push('匿名公开内容规范两语言、320/768/1366无横向溢出、键盘跳转和确切审核入口');
 const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, ignoreHTTPSErrors: new URL(base).protocol === 'https:' }); page = await context.newPage(); page.setDefaultTimeout(30000);
 page.on('pageerror', error => errors.push(error.message));
 page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/control')) calls.push(request.postDataJSON()); });
 await login(context.request); await page.goto(base + '/dashboard/chats?agent=agent-a1'); await composer().waitFor();
 await page.getByRole('region', { name: '与 同步测试 A1 对话', exact: true }).waitFor();
 const workspace = await (await context.request.get(base + '/api/agents/agent-a1/workspace')).json();
 await page.getByRole('button', { name: '新对话', exact: true }).click(); await composer().fill('拒绝时保留这份草稿');
 await send().click(); await page.getByRole('heading', { name: '管理内容共享许可', exact: true }).waitFor();
 assert.ok((await dialog().innerText()).includes(base)); assert.ok((await dialog().innerText()).includes(workspace.agent.urn)); assert.ok((await dialog().innerText()).includes('你自行配置的模型与工具')); assert.equal(sendCount(), 0);
 await dialog().getByRole('button', { name: '拒绝并返回', exact: true }).click(); assert.equal(await composer().inputValue(), '拒绝时保留这份草稿'); assert.equal(sendCount(), 0);
 checks.push('真实URL/名称/URN及模型工具说明；拒绝不派发且保留草稿');
 await manage(); await approve(); assert.equal(sendCount(), 0);
 await composer().fill('同意后重新核对并明确发送'); await send().click();
 await history().getByText('这是自动同步回来的回复', { exact: true }).waitFor({ timeout: 120000 });
 assert.equal(sendCount(), 1); assert.equal(calls.find(call => call.method === 'conversation.send').params.text, '同意后重新核对并明确发送');
 checks.push('同意仅返回；重新提交时使用当前草稿，不自动发送旧点击');
 // Simulate a lost HTTP receipt after the real isolated backend commits. No
 // resend is automatic; refresh must retain the exact original account scope.
 let reportBody, reportReceipt, reportPosts = 0; const reportGets = [];
 page.on('request', request => { if(request.method()==='GET' && request.url().includes('/api/moderation/reports/')) reportGets.push(request.url()); });
 await page.route(base+'/api/moderation/reports', async route => {
  if(route.request().method()!=='POST') return route.continue();
  reportPosts++; reportBody=route.request().postDataJSON(); const reply=await route.fetch();
  assert.equal(reply.status(),200); reportReceipt=(await reply.json()).report;
  assert.equal(reportReceipt.id,reportBody.reportId); await route.abort('failed');
 });
 await page.getByRole('group',{name:/^举报 Agent 回复 /}).first().getByRole('button',{name:'举报内容',exact:true}).click();
 await dialog().getByRole('heading',{name:'举报这条记录',exact:true}).waitFor();
 await dialog().getByRole('button',{name:'确认提交举报',exact:true}).waitFor();
 const evidenceToggle=dialog().getByRole('checkbox',{name:'附上这段已预览的证据',exact:true});
 if(await evidenceToggle.count()) assert.equal(await evidenceToggle.isChecked(),false);
 await dialog().getByLabel('补充说明（选填）',{exact:true}).fill('仅提交标识的合成浏览器验收');
 await dialog().getByRole('checkbox',{name:'我同意将上述原因、说明与勾选证据提交给本工作区处理人员。',exact:true}).check();
 await dialog().getByRole('button',{name:'确认提交举报',exact:true}).click();
 await dialog().getByRole('button',{name:'核实原举报',exact:true}).waitFor();
 assert.equal(reportPosts,1); assert.equal(reportBody.evidence,''); assert.equal(reportBody.consent,true);
 const originalReportId=reportBody.reportId;
 assert.equal(await page.evaluate(id=>Object.keys(localStorage).filter(key=>key.startsWith('content-report:v1:')).some(key=>JSON.parse(localStorage.getItem(key)).reportId===id),originalReportId),true);
 await page.reload(); await composer().waitFor();
 await page.getByRole('group',{name:/^举报 Agent 回复 /}).first().getByRole('button',{name:'举报内容',exact:true}).click();
 await dialog().getByRole('button',{name:'核实原举报',exact:true}).click();
 await dialog().getByRole('link',{name:'查看我的举报',exact:true}).waitFor();
 assert.ok(reportGets.some(url=>url===base+'/api/moderation/reports/'+originalReportId)); assert.equal(reportPosts,1);
 assert.equal(await page.evaluate(id=>Object.keys(localStorage).filter(key=>key.startsWith('content-report:v1:')).some(key=>JSON.parse(localStorage.getItem(key)).reportId===id),originalReportId),false);
 await page.screenshot({path:path.join(out,'report-verified.png'),fullPage:true}); await page.keyboard.press('Escape');
 await page.unroute(base+'/api/moderation/reports'); await manage(); await approve(); assert.equal(sendCount(),1);
 checks.push('独立举报显式许可、不附正文、Web Locks保存先于HTTP；丢回执刷新恢复原ID，GET核实后清理且不重发');
 await manage(); await dialog().getByRole('button', { name: '撤回共享许可', exact: true }).click();
 await history().getByText('同意后重新核对并明确发送', { exact: true }).waitFor();
 await composer().fill('撤回后的草稿'); await send().click(); await page.getByRole('heading', { name: '管理内容共享许可', exact: true }).waitFor(); assert.equal(sendCount(), 1); await approve(); assert.equal(sendCount(), 1);
 checks.push('撤回后阅读已有内容；新点击重新要求同意但不自动派发');
 await page.getByRole('button', { name: '与 同步测试 A2 聊天', exact: true }).click(); await page.getByRole('region', { name: '与 同步测试 A2 对话', exact: true }).waitFor(); await page.getByRole('button', { name: '管理共享许可，尚未允许', exact: true }).first().waitFor();
 await page.getByRole('button', { name: '与 同步测试 A1 聊天', exact: true }).click(); await page.getByRole('region', { name: '与 同步测试 A1 对话', exact: true }).waitFor(); await page.getByRole('button', { name: '管理共享许可，尚未允许', exact: true }).first().waitFor();
 checks.push('切换Agent并切回都不恢复旧许可');
 await manage(); await approve(); await page.reload(); await composer().waitFor(); await page.getByRole('button', { name: '管理共享许可，尚未允许', exact: true }).first().waitFor();
 checks.push('冷页面重新加载不保存许可');
 await manage(); await approve(); await login(context.request); await composer().fill('重新登录必须再次许可'); await send().click(); await page.getByRole('button', { name: '管理共享许可，尚未允许', exact: true }).first().waitFor(); assert.equal(sendCount(), 1);
 checks.push('同账户重新登录使旧登录会话许可失效');
 await page.setViewportSize({ width: 320, height: 640 }); await manage();
 const bounds = await dialog().evaluate(element => { const b=element.getBoundingClientRect(); return { left:b.left, right:b.right, top:b.top, bottom:b.bottom, width:innerWidth, height:innerHeight }; });
 assert.ok(bounds.left>=0 && bounds.right<=bounds.width+1 && bounds.top>=0 && bounds.bottom<=bounds.height+1, JSON.stringify(bounds));
 await dialog().getByRole('button', { name: '同意共享并返回', exact: true }).scrollIntoViewIfNeeded(); await page.screenshot({ path: path.join(out,'sharing-320x640.png'), fullPage: true }); await approve(); assert.equal(sendCount(), 1);
 checks.push('320×640说明可滚动且同意/拒绝可触达，无横向溢出');
 assert.deepEqual(errors, []); fs.writeFileSync(path.join(out,'results.json'), JSON.stringify({ passed:true, checks, errors, contentSends:sendCount() },null,2)); console.log(JSON.stringify({ passed:true, checks }));
}
main().catch(async error => { console.error(error.stack); if(page) { try { await page.screenshot({ path:path.join(out,'failure.png'), fullPage:true }); fs.writeFileSync(path.join(out,'failure.json'), JSON.stringify({ error:error.message, body:await page.locator('body').innerText(), calls, errors },null,2)); } catch {} } process.exitCode=1; }).finally(async()=>{ if(browser) await browser.close(); });
