// Run against MUTATION_FIXTURE=1 node tests/integration/workspace-fixture.cjs.
// This check deliberately refuses non-loopback targets.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const base = process.env.WORKSPACE_BROWSER_URL || "http://127.0.0.1:3062";
const platform = process.env.WORKSPACE_FIXTURE_URL || "http://127.0.0.1:3061";
for (const url of [base, platform]) assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(url).hostname));
const output = path.resolve(__dirname, "../../build/workspace-mutations-preview");
fs.mkdirSync(output, { recursive: true });
const writes = [], errors = [], checks = [];
let browser, page, nextFailure = "";
async function shot(name) { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: "disabled" }); }
async function noOverflow() {
  const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, main: document.querySelector("main").clientWidth, content: document.querySelector("main").scrollWidth }));
  assert.equal(size.document, size.viewport, JSON.stringify(size));
  assert.ok(size.content <= size.main + 1, JSON.stringify(size));
}
async function contact(name, urn) {
  await page.getByLabel("姓名或称呼", { exact: true }).fill(name);
  await page.getByLabel("其他别名", { exact: false }).fill("朋友，协作伙伴");
  await page.getByLabel("对方的 URN", { exact: true }).fill(urn);
  assert.equal(await page.getByRole("button", { name: "添加并排队好友请求", exact: true }).isDisabled(), true);
  await page.getByRole("checkbox").check();
}
async function decision(id, name) {
  await page.locator(`#subject-${id}`).getByRole("button", { name, exact: true }).click();
  await page.locator(`#subject-${id}`).waitFor({ state: "detached" });
}
async function main() {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  page = await context.newPage(); page.setDefaultTimeout(25000);
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/agents/*/control", async route => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    const call = request.postDataJSON();
    if (!["contacts.add", "approval.respond"].includes(call.method)) return route.continue();
    writes.push(call);
    const failure = nextFailure; nextFailure = "";
    if (failure === "disconnect") return route.abort("connectionreset");
    if (failure === "expired") return route.fulfill({ status: 410, contentType: "application/json", body: JSON.stringify({ error: "旧请求已过期，无法查询受理结果。" }) });
    if (failure === "accepted_then_disconnect") { await route.fetch(); return route.abort("connectionreset"); }
    return route.continue();
  });
  await page.goto(`${base}/login`);
  await page.getByLabel("邮箱", { exact: true }).fill("owner-a@workspace.invalid");
  await page.getByLabel("密码", { exact: true }).fill("Workspace-smoke-fixture-2026");
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  await page.waitForURL("**/dashboard/agents");
  await page.getByRole("link", { name: "打开 同步测试 A1 的远程工作台", exact: true }).click();
  await page.waitForURL("**/dashboard/agents/agent-a1");
  const agentUrl = page.url();
  await page.getByRole("tab", { name: "联系人", exact: true }).click();
  assert.equal(writes.length, 0, "Mounting and opening tabs must never submit a mutation");
  await page.getByRole("button", { name: "添加联系人", exact: true }).click();
  await contact("网页测试联系人", "urn:agent-comm:agent:web-browser-contact");
  await noOverflow(); await shot("01-contact-confirmation-desktop");
  nextFailure = "disconnect";
  await page.getByRole("button", { name: "添加并排队好友请求", exact: true }).click();
  await page.getByRole("button", { name: "重试本次添加", exact: true }).waitFor();
  const first = writes.at(-1);
  assert.match(first.params.contact_id, /^contact-/);
  await page.goto(`${agentUrl}?tab=contacts`);
  await page.getByRole("button", { name: "重试本次添加", exact: true }).waitFor();
  assert.equal(writes.length, 1, "Reload must restore unknown status without resending a write");
  await shot("02-contact-unknown-reloaded");
  await page.getByRole("button", { name: "重试本次添加", exact: true }).click();
  await page.locator("article").filter({ hasText: "网页测试联系人" }).waitFor();
  assert.deepEqual(writes.at(-1), first, "Retry preserves the request ID and exact contact mapping");
  checks.push("显式核对联系人映射；断线后刷新保留原请求且不自动写入；重试保持 request ID 和完整参数");

  await page.getByRole("button", { name: "添加另一位联系人", exact: true }).click();
  await contact("过期请求测试联系人", "urn:agent-comm:agent:expired-browser-contact");
  nextFailure = "expired";
  await page.getByRole("button", { name: "添加并排队好友请求", exact: true }).click();
  await page.getByRole("button", { name: "重新提交相同内容", exact: true }).waitFor();
  const expired = writes.at(-1);
  await page.getByRole("button", { name: "重新提交相同内容", exact: true }).click();
  await page.locator("article").filter({ hasText: "过期请求测试联系人" }).waitFor();
  assert.notEqual(writes.at(-1).request_id, expired.request_id);
  assert.deepEqual(writes.at(-1).params, expired.params, "Receipt expiry recovery preserves the business identity and payload");
  checks.push("已过期且未执行请求可显式重新提交；新 request ID 仍保留原 contact_id 和全部参数");

  await page.getByRole("tab", { name: "事项", exact: true }).click();
  await page.getByText("请核对：仅向小王发送明天下午 3 点的会议提议。\n不会创建日历，也不代表对方已经同意。", { exact: true }).waitFor();
  await noOverflow(); await shot("03-approval-requests-desktop");
  await decision("approval-web-approve", "同意本次请求");
  await decision("approval-web-deny", "拒绝本次请求");
  await decision("approval-web-expired", "同意本次请求");
  checks.push("完整审批正文可直接查看；待确认、已在本机展示及展示过期的请求均可网页决定");

  nextFailure = "accepted_then_disconnect";
  await decision("approval-web-unknown", "同意本次请求");
  await page.getByText("Agent 已同步此请求的同意记录。", { exact: true }).waitFor();
  assert.equal(writes.filter(call => call.params.approval_id === "approval-web-unknown").length, 1);
  checks.push("审批写入后丢失响应时，凭 agent 同步的终态核实结果，没有重复提交");
  await page.locator("#subject-approval-web-fail").getByRole("button", { name: "同意本次请求", exact: true }).click();
  await page.locator("#subject-approval-web-fail").getByRole("alert").waitFor();
  assert.equal(await page.locator("#subject-approval-web-fail").count(), 1);
  checks.push("agent 拒绝已撤销事项时保留失败反馈，未伪装成功或移除待确认项");
  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(); await shot("04-approval-result-mobile");
  await page.getByRole("tab", { name: "联系人", exact: true }).click();
  await noOverflow(); await shot("05-contacts-mobile");

  await fetch(`${platform}/fixture/mode`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ writesAllowed: false, expireCapabilities: true, due: true }) });
  await page.getByRole("button", { name: "连接设置", exact: true }).click();
  await page.getByRole("button", { name: "重新检查连接", exact: true }).click();
  await page.getByText("当前连接尚未开放在网页添加联系人，请在连接设置中检查授权。", { exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "添加另一位联系人", exact: true }).isDisabled(), true);
  await page.getByRole("tab", { name: "事项", exact: true }).click();
  assert.equal(await page.locator("#subject-approval-web-fail").getByRole("button", { name: "同意本次请求", exact: true }).isDisabled(), true);
  checks.push("同步授权撤回后联系人和审批写入按钮均禁用");
  const report = await (await fetch(`${platform}/fixture/summary`)).json();
  assert.equal(report.mutationContacts.length, 2);
  assert.equal(report.mutationDecisions.length, 4);
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, "browser-report.json"), JSON.stringify({ checks, browserWrites: writes.length, contacts: report.mutationContacts.length, decisions: report.mutationDecisions.length, errors }, null, 2));
  console.log(JSON.stringify({ ok: true, checks }, null, 2));
}
main().catch(async error => { console.error(error); if (page) await shot("failure").catch(() => {}); process.exitCode = 1; }).finally(async () => { await browser?.close(); });
