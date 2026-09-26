// Run against ATTENTION_FIXTURE=1 workspace-fixture.cjs. All data stays on loopback.
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const base='http://127.0.0.1:3062',output=path.resolve(__dirname,'../../build/notifications-preview');
fs.mkdirSync(output,{recursive:true});
let browser;const checks=[],errors=[];
async function main(){
 browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
 const context=await browser.newContext({viewport:{width:1440,height:1050}});
 await context.addInitScript(()=>{
  window.__notificationCalls=[];
  class FakeNotification {static permission='default';static async requestPermission(){this.permission='granted';return 'granted';}constructor(title,options){window.__notificationCalls.push({title,...options});}close(){}}
  Object.defineProperty(window,'Notification',{value:FakeNotification,configurable:true});
 });
 const page=await context.newPage();page.setDefaultTimeout(20000);page.on('pageerror',e=>errors.push(e.message));
 await page.goto(base+'/login?callbackUrl=/dashboard/agents');await page.getByLabel('邮箱',{exact:true}).fill('owner-a@workspace.invalid');await page.getByLabel('密码',{exact:true}).fill('Workspace-smoke-fixture-2026');await page.getByRole('button',{name:'进入工作空间',exact:true}).click();await page.waitForURL('**/dashboard/agents');
 const bell=page.getByRole('link',{name:/提醒中心，2 条未读，2 项待处理/});await bell.waitFor({timeout:45000});
 assert.equal(await page.evaluate(()=>window.__notificationCalls.length),0);
 await bell.click();await page.getByRole('heading',{name:'提醒中心',exact:true}).waitFor();await page.getByRole('heading',{name:'确认会议时间',exact:true}).first().waitFor();
 const unreadTab=page.getByRole('tab',{name:'未读',exact:true});
 assert.equal(await unreadTab.getAttribute('aria-selected'),'true','notification center should open on the concise unread view');
 checks.push('未进入任何agent详情便可从全局入口看到跨连接待办；未主动开启前不请求系统通知');
 await page.getByRole('button',{name:'标记已读',exact:true}).first().click();await page.getByText('1 条未读 · 2 项待你处理',{exact:true}).waitFor();
 const unreadItems=await page.locator('#notifications-panel article').count();
 const allTab=page.getByRole('tab',{name:'全部',exact:true});
 await allTab.click();await page.waitForFunction(count=>document.querySelectorAll('#notifications-panel article').length>count,unreadItems);
 await unreadTab.click();await page.waitForFunction(count=>document.querySelectorAll('#notifications-panel article').length===count,unreadItems);
 checks.push('未读视图默认收敛；标记已读减少未读数但不减少待确认数，全部中可找回历史');
 await page.screenshot({path:path.join(output,'01-notifications-desktop.png'),fullPage:true});
 const second=await context.newPage();await second.goto(base+'/dashboard/notifications');await second.getByText('1 条未读 · 2 项待你处理',{exact:true}).waitFor();
 checks.push('第二个标签从账户服务端恢复同一已读与待处理状态');
 await page.bringToFront();
 const settings=page.locator('details[aria-label="提醒设置"]');
 assert.equal(await settings.evaluate(element=>element.open),false,'notification settings should start collapsed');
 assert.equal(await page.getByRole('button',{name:'开启系统提醒',exact:true}).isVisible(),false,'device controls should not occupy the default notification view');
 await settings.locator('summary').first().click();
 assert.equal(await settings.evaluate(element=>element.open),true);
 await page.getByRole('button',{name:'开启系统提醒',exact:true}).click();await page.getByRole('button',{name:'关闭系统提醒',exact:true}).waitFor();
 assert.equal(await page.evaluate(()=>window.__notificationCalls.length),0,'foreground must not produce system notices');
 await page.getByRole('button',{name:'关闭系统提醒',exact:true}).click();
 await settings.locator('summary').first().click();
 assert.equal(await settings.evaluate(element=>element.open),false);
 checks.push('提醒设置默认收起且可重新关闭；设备开关由用户点击触发，未发送真实系统通知');
 const response=await context.request.get(base+'/api/notifications');const data=await response.json();const pending=data.items.find(i=>i.unread);
 const claimBody={action:'claim',agentId:pending.agentId,id:pending.id,revision:pending.revision,deviceId:'11111111-1111-4111-8111-111111111111'};
 const [one,two]=await Promise.all([context.request.post(base+'/api/notifications',{headers:{Origin:base},data:claimBody}),context.request.post(base+'/api/notifications',{headers:{Origin:base},data:claimBody})]);
 assert.deepEqual([(await one.json()).claimed,(await two.json()).claimed].sort(),[false,true]);
 const forbidden=await context.request.post(base+'/api/notifications',{headers:{Origin:'https://other.invalid'},data:{action:'read',agentId:pending.agentId,id:pending.id,revision:pending.revision}});assert.equal(forbidden.status(),403);
 checks.push('并发标签的设备投递声明仅一方成功；跨源修改被拒绝');
 await page.getByRole('link',{name:'查看当前事项',exact:true}).first().click();await page.getByRole('tab',{name:'事项',exact:true}).waitFor();assert.equal(await page.getByRole('tab',{name:'事项',exact:true}).getAttribute('aria-selected'),'true');
 await page.getByText('项目方案讨论',{exact:true}).waitFor();await page.getByText('部分接受，等待另一方',{exact:true}).waitFor();
 assert.equal(await page.getByRole('button',{name:/^同意$|^批准$/}).count(),0);await page.screenshot({path:path.join(output,'02-collaboration-desktop.png'),fullPage:true});checks.push('通知定位事项与原生问题；v2显示条款和部分接受，不提供Web审批');
 await page.goto(base+'/dashboard/notifications');await page.setViewportSize({width:390,height:844});await page.getByRole('heading',{name:'确认会议时间',exact:true}).first().waitFor();
 const dimensions=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,main:document.querySelector('main').clientWidth,content:document.querySelector('main').scrollWidth}));assert.equal(dimensions.width,dimensions.scroll);assert.ok(dimensions.content<=dimensions.main+1);await page.screenshot({path:path.join(output,'03-notifications-mobile.png'),fullPage:true});checks.push('390px手机视口无横向溢出，阅读与原生处理入口可用');
 await context.request.post('http://127.0.0.1:3061/fixture/mode',{data:{resolveApproval:true,due:true}});await page.getByText(/0 项待你处理/).waitFor({timeout:80000});checks.push('源端明确resolved后各端待处理数收敛为0');
 assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'report.json'),JSON.stringify({checks,errors,systemNotifications:'stubbed; none sent'},null,2));console.log(JSON.stringify({passed:checks.length,checks},null,2));
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();});
