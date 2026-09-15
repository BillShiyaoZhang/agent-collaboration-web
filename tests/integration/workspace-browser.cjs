// Manual integration check against the isolated signed-MQ fixture started by the release checks.
// This never runs as part of npm test and deliberately refuses non-loopback targets.
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const base = process.env.WORKSPACE_BROWSER_URL || "http://127.0.0.1:3062";
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname), "This check only permits a local fixture server");
const output = path.resolve(__dirname, "../../build/workspace-sync-preview");
fs.mkdirSync(output, { recursive: true });
const checks = [], errors = [], controlCalls = [], syncCalls = [];
let browser, page;

async function shot(name) { await page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true, animations: "disabled" }); }
async function noOverflow() {
  const size = await page.evaluate(() => ({ width: innerWidth, document: document.documentElement.scrollWidth,
    main: document.querySelector("main").clientWidth, content: document.querySelector("main").scrollWidth }));
  assert.equal(size.document, size.width, JSON.stringify(size));
  assert.ok(size.content <= size.main + 1, JSON.stringify(size));
}
async function sendAndWait(text) {
  const composer = page.getByRole("textbox", { name: "给 agent 的消息", exact: true });
  await composer.fill(text);
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.getByLabel("对话记录", { exact: true }).getByText(text, { exact: true }).waitFor();
  await page.getByText("这是自动同步回来的回复", { exact: true }).last().waitFor({ timeout: 120000 });
  assert.equal(await composer.inputValue(), "");
  return page.getByLabel("选择历史对话", { exact: true }).inputValue();
}

async function main() {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  page = await context.newPage(); page.setDefaultTimeout(20000);
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.endsWith("/control") && request.method() === "POST") controlCalls.push(request.postDataJSON().method);
    if (url.pathname === "/api/workspace/sync" && request.method() === "POST") syncCalls.push(request.postDataJSON());
  });
  await page.goto(`${base}/login`);
  await page.getByLabel("邮箱", { exact: true }).fill("owner-a@workspace.invalid");
  await page.getByLabel("密码", { exact: true }).fill("Workspace-smoke-fixture-2026");
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  await page.waitForURL("**/dashboard/agents");
  const firstCard = page.getByRole("link", { name: "打开 同步测试 A1 的远程工作台", exact: true });
  const secondCard = page.getByRole("link", { name: "打开 同步测试 A2 的远程工作台", exact: true });
  await firstCard.getByText("最近同步", { exact: false }).waitFor();
  await secondCard.getByText("最近同步", { exact: false }).waitFor();
  assert.equal(controlCalls.length, 0, "merely entering the workspace must not run browser RPCs");
  checks.push("两个连接进入页面前已由服务端主动同步，登录直接显示已保存内容");
  await noOverflow(); await shot("01-connections-desktop");

  await firstCard.click();
  await page.getByRole("tab", { name: "联系人", exact: true }).click();
  await page.getByText("自动同步联系人", { exact: true }).first().waitFor();
  await page.getByRole("tab", { name: "收件箱", exact: true }).click();
  await page.getByText("这是一条主动同步的来信", { exact: true }).waitFor();
  assert.equal(controlCalls.length, 0, "opening a tab must use already-synced data without on-click RPC");
  checks.push("联系人与收件箱无需刷新即显示；切换标签未触发远程读取");
  await shot("02-inbox-desktop");

  await page.getByRole("tab", { name: "对话", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "给 agent 的消息", exact: true });
  await composer.fill("这是一段尚未发送的草稿");
  await page.getByRole("tab", { name: "联系人", exact: true }).click();
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  assert.equal(await composer.inputValue(), "这是一段尚未发送的草稿");
  const agentUrl = page.url();
  await page.getByRole("navigation", { name: "面包屑" }).getByRole("link", { name: "我的连接", exact: true }).click();
  await page.getByRole("link", { name: "打开 同步测试 A1 的远程工作台", exact: true }).click();
  assert.equal(await composer.inputValue(), "这是一段尚未发送的草稿");
  checks.push("标签与连接页面切换保留未发送草稿");

  // Explicitly start a fresh conversation so this manual check is repeatable on its local fixture.
  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.waitForFunction(() => !document.querySelector("#saved-conversation") || document.querySelector("#saved-conversation").value === "");
  const firstId = await sendAndWait("本地浏览器验证：请回复一句话。");
  assert.ok(firstId);
  checks.push("发送后无需读取按钮，服务端主动同步完成回复");
  await shot("03-conversation-desktop");
  await page.reload();
  await page.getByText("这是自动同步回来的回复", { exact: true }).last().waitFor();
  assert.equal(await page.getByLabel("选择历史对话", { exact: true }).inputValue(), firstId);
  checks.push("刷新后自动恢复选中会话、用户消息与agent回复");

  await page.getByRole("button", { name: "新对话", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#saved-conversation").value === "");
  const secondId = await sendAndWait("本地浏览器验证：这是第二个独立对话。");
  assert.notEqual(secondId, firstId);
  await page.getByLabel("选择历史对话", { exact: true }).selectOption(firstId);
  await page.getByLabel("对话记录", { exact: true }).getByText("本地浏览器验证：请回复一句话。", { exact: true }).waitFor();
  await page.reload();
  assert.equal(await page.getByLabel("选择历史对话", { exact: true }).inputValue(), firstId);
  checks.push("历史列表可切换独立会话，选择保存在服务端并跨刷新恢复");
  assert.ok(syncCalls.some(call => !call.agentId), "workspace mount should schedule all connections proactively");
  assert.equal(controlCalls.filter(method => method === "conversation.send").length, 2);
  assert.equal(controlCalls.filter(method => method !== "conversation.send").length, 0, "normal chat progression is synced by the server");

  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow(); await shot("04-conversation-mobile");
  await page.getByRole("tab", { name: "联系人", exact: true }).click();
  await page.getByText("自动同步联系人", { exact: true }).first().waitFor();
  await noOverflow(); await shot("05-contacts-mobile");
  await page.setViewportSize({ width: 320, height: 740 });
  await noOverflow();
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  await noOverflow();
  checks.push("390px与320px手机界面无横向溢出，历史对话和联系人均可使用");
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, "browser-result.json"), JSON.stringify({ checks, errors, controlCalls, syncCalls: syncCalls.length,
    scope: "Loopback-only production Next preview with isolated account and cryptographically authenticated local MQ fixture.", agentUrl }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, errors }, null, 2));
}

main().catch(async error => {
  if (page) await shot("browser-failure").catch(() => {});
  fs.writeFileSync(path.join(output, "browser-failure.json"), JSON.stringify({ checks, errors, message: error.message, controlCalls }, null, 2));
  console.error(error); process.exitCode = 1;
}).finally(async () => { if (browser) await browser.close(); });

