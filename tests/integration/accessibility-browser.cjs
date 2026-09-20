// Manual accessibility regression check for the site and authenticated workspace.
//
// The workspace side uses the loopback-only workspace-fixture.cjs. Start a built
// app with that fixture first, then run this script. A static HTTP server is
// created here for site/index.html so the public page is tested in isolation.
//
// Example:
//   npm run build
//   node tests/integration/workspace-fixture.cjs
//   PLAYWRIGHT_MODULE=/path/to/playwright \
//     CHROME_EXECUTABLE=/path/to/chromium \
//     node tests/integration/accessibility-browser.cjs

const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const axePath = (() => {
  try { return require.resolve("axe-core/axe.js"); } catch { return null; }
})();
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const siteFile = path.join(root, "site/index.html");
const workspaceBase = process.env.WORKSPACE_BROWSER_URL || "http://127.0.0.1:3062";
const fixtureBase = process.env.WORKSPACE_FIXTURE_URL || "http://127.0.0.1:3061";
for (const value of [workspaceBase, fixtureBase]) {
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname), `Loopback URL required: ${value}`);
}

const output = path.resolve(root, "build/accessibility-preview");
fs.mkdirSync(output, { recursive: true });
const checks = [];
const errors = [];
let browser;
let staticServer;

async function dimensions(page) {
  return page.evaluate(() => ({
    viewport: innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    main: document.querySelector("main")?.clientWidth ?? null,
    content: document.querySelector("main")?.scrollWidth ?? null,
  }));
}

async function assertNoOverflow(page, label) {
  const size = await dimensions(page);
  assert.equal(size.document, size.viewport, `${label}: document overflow ${JSON.stringify(size)}`);
  assert.equal(size.body, size.viewport, `${label}: body overflow ${JSON.stringify(size)}`);
  if (size.main !== null) assert.ok(size.content <= size.main + 1, `${label}: main overflow ${JSON.stringify(size)}`);
}

async function assertViewportMeta(page, label) {
  const content = await page.locator('meta[name="viewport"]').getAttribute("content");
  assert.match(content || "", /width\s*=\s*device-width/i, `${label}: responsive viewport meta is missing`);
}

async function textFailures(page, min = 12) {
  return page.evaluate(({ minSize }) => {
    const failures = [];
    for (const element of document.querySelectorAll("body *")) {
      if (element.closest('[aria-hidden="true"]')) continue;
      if (![...element.childNodes].some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) continue;
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") continue;
      const size = Number.parseFloat(style.fontSize);
      if (size < minSize) failures.push({ tag: element.tagName, text: element.textContent.trim().replace(/\s+/g, " ").slice(0, 90), size, lineHeight: style.lineHeight });
    }
    return failures;
  }, { minSize: min });
}

async function assertReadableText(page, label) {
  const failures = await textFailures(page);
  assert.deepEqual(failures, [], `${label}: visible text below 12px ${JSON.stringify(failures)}`);
}

async function inputFailures(page) {
  return page.evaluate(() => [...document.querySelectorAll("input, textarea")].filter(element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") return false;
    return Number.parseFloat(getComputedStyle(element).fontSize) < 16;
  }).map(element => ({ tag: element.tagName, id: element.id, size: getComputedStyle(element).fontSize })));
}

async function assertReadableInputs(page, label) {
  const failures = await inputFailures(page);
  assert.deepEqual(failures, [], `${label}: inputs below 16px ${JSON.stringify(failures)}`);
}

async function targetFailures(page) {
  return page.evaluate(() => [...document.querySelectorAll("a, button, input, textarea, select, summary, [role=button], [role=tab]")].filter(element => {
    if (element.closest('[aria-hidden="true"]') || element.classList.contains("sr-only")) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden") return false;
    return rect.width < 24 || rect.height < 24;
  }).map(element => {
    const rect = element.getBoundingClientRect();
    return { tag: element.tagName, text: element.textContent.trim().replace(/\s+/g, " ").slice(0, 80), width: Math.round(rect.width), height: Math.round(rect.height) };
  }));
}

async function assertTouchTargets(page, label) {
  const failures = await targetFailures(page);
  assert.deepEqual(failures, [], `${label}: target below 24px ${JSON.stringify(failures)}`);
}

async function assertRootScale(page, label) {
  const before = await page.evaluate(() => ({ html: getComputedStyle(document.documentElement).fontSize, body: getComputedStyle(document.body).fontSize }));
  await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
  const after = await page.evaluate(() => ({ html: getComputedStyle(document.documentElement).fontSize, body: getComputedStyle(document.body).fontSize }));
  assert.ok(Number.parseFloat(after.html) >= Math.max(31, Number.parseFloat(before.html) * 1.9), `${label}: root text scale was not applied ${JSON.stringify({ before, after })}`);
  assert.ok(Number.parseFloat(after.body) >= 30, `${label}: body did not follow root text scale ${JSON.stringify({ before, after })}`);
  await assertNoOverflow(page, `${label} at 200% text scale`);
  await page.evaluate(() => { document.documentElement.style.fontSize = ""; });
}

async function assertKeyboardSkip(page, label, href) {
  await page.goto(`${page.url().split("#")[0]}`, { waitUntil: "domcontentloaded" });
  await page.keyboard.press("Tab");
  const focused = await page.evaluate(expected => ({ href: document.activeElement?.getAttribute("href"), text: document.activeElement?.textContent?.trim() }), href);
  assert.equal(focused.href, href, `${label}: first Tab did not focus skip link`);
  checks.push(`${label}: skip link is first keyboard target`);
}

async function assertAxeContrast(page, label) {
  if (!axePath) {
    checks.push(`${label}: axe-core unavailable, contrast scan skipped`);
    return;
  }
  if (!await page.evaluate(() => Boolean(window.axe))) await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: ["color-contrast"] });
    return result.violations.map(item => ({ id: item.id, impact: item.impact, nodes: item.nodes.length }));
  });
  assert.deepEqual(violations, [], `${label}: color contrast violations ${JSON.stringify(violations)}`);
  checks.push(`${label}: axe color-contrast scan passed`);
}

async function auditPage(page, label, { skip = true, axe = true } = {}) {
  await assertViewportMeta(page, label);
  await assertNoOverflow(page, label);
  await assertReadableText(page, label);
  await assertReadableInputs(page, label);
  await assertTouchTargets(page, label);
  if (skip) await assertKeyboardSkip(page, label, page.url().includes("dashboard") ? "#main-content" : "#main");
  await assertRootScale(page, label);
  if (axe) await assertAxeContrast(page, label);
  checks.push(`${label}: readable text, 16px inputs, touch targets, reflow and 200% root scale passed`);
}

async function serveSite() {
  staticServer = http.createServer((request, response) => {
    const pathname = new URL(request.url, "http://127.0.0.1").pathname;
    if (pathname === "/" || pathname === "/index.html") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      response.end(fs.readFileSync(siteFile));
      return;
    }
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  });
  await new Promise(resolve => staticServer.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${staticServer.address().port}`;
}

async function login(page) {
  await page.goto(`${workspaceBase}/login`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("邮箱", { exact: true }).fill("owner-a@workspace.invalid");
  await page.getByLabel("密码", { exact: true }).fill("Workspace-smoke-fixture-2026");
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  await page.waitForURL("**/dashboard/agents");
}

async function main() {
  const staticBase = await serveSite();
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message));

  await page.goto(staticBase, { waitUntil: "domcontentloaded" });
  await auditPage(page, "public site desktop");
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(staticBase, { waitUntil: "domcontentloaded" });
  await auditPage(page, "public site 320px");

  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(`${workspaceBase}/login`, { waitUntil: "domcontentloaded" });
  await auditPage(page, "login desktop", { skip: false });
  await page.goto(`${workspaceBase}/register`, { waitUntil: "domcontentloaded" });
  await auditPage(page, "register desktop", { skip: false });

  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${workspaceBase}/login`, { waitUntil: "domcontentloaded" });
  await auditPage(page, "login 320px", { skip: false });
  await page.goto(`${workspaceBase}/register`, { waitUntil: "domcontentloaded" });
  await auditPage(page, "register 320px", { skip: false });

  await page.setViewportSize({ width: 1440, height: 1050 });
  await login(page);
  await auditPage(page, "agents desktop");

  // The Add connection dialog is a representative Radix modal. Escape must
  // close it and return focus to the trigger instead of leaving focus in the DOM.
  const addConnection = page.getByRole("button", { name: "添加连接", exact: true });
  await addConnection.click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await dialog.waitFor({ state: "hidden" });
  assert.equal(await addConnection.evaluate(element => document.activeElement === element), true, "dialog Escape must restore focus to Add connection trigger");
  checks.push("connection dialog Escape closes and restores trigger focus");

  const firstAgent = page.getByRole("link", { name: /打开 同步测试 A1 的远程工作台/ }).first();
  await firstAgent.click();
  await page.waitForURL("**/dashboard/agents/agent-a1");
  await page.getByRole("tab", { name: "对话", exact: true }).click();
  const composer = page.getByRole("textbox", { name: "给 agent 的消息", exact: true });
  await composer.waitFor();
  assert.equal(Number.parseFloat(await composer.evaluate(element => getComputedStyle(element).fontSize)) >= 16, true, "conversation composer must use at least 16px text");
  await page.getByRole("tab", { name: "联系人", exact: true }).click();
  await page.getByRole("tab", { name: "联系人", exact: true }).waitFor();
  await page.getByText("自动同步联系人", { exact: true }).first().waitFor();
  assert.equal(await page.getByRole("tab", { name: "联系人", exact: true }).getAttribute("aria-selected"), "true");
  await assertNoOverflow(page, "workbench contacts desktop");
  await assertReadableText(page, "workbench contacts desktop");
  await assertTouchTargets(page, "workbench contacts desktop");
  await assertAxeContrast(page, "workbench contacts desktop");
  checks.push("authenticated workbench conversation composer and contacts tab are reachable with readable controls");

  await page.setViewportSize({ width: 320, height: 740 });
  await assertNoOverflow(page, "workbench contacts 320px");
  await assertReadableText(page, "workbench contacts 320px");
  await assertReadableInputs(page, "workbench contacts 320px");
  await assertTouchTargets(page, "workbench contacts 320px");
  await assertRootScale(page, "workbench contacts 320px");
  checks.push("workbench contacts reflow at 320px");

  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto(`${workspaceBase}/dashboard/notifications`, { waitUntil: "domcontentloaded" });
  const tablist = page.getByRole("tablist", { name: "提醒筛选", exact: true });
  await tablist.waitFor();
  const filterTabs = page.getByRole("tab");
  assert.equal(await filterTabs.count(), 3, "notifications must expose three filter tabs");
  assert.equal(await page.locator('[role="tab"][aria-selected="true"]').count(), 1, "exactly one notification filter must be selected");
  await page.getByRole("tab", { name: "未读", exact: true }).click();
  assert.equal(await page.getByRole("tab", { name: "未读", exact: true }).getAttribute("aria-selected"), "true");
  await auditPage(page, "notifications desktop");

  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${workspaceBase}/dashboard/agents`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "我的连接", exact: true }).waitFor();
  await auditPage(page, "agents 320px");
  await page.goto(`${workspaceBase}/dashboard/notifications`, { waitUntil: "domcontentloaded" });
  await tablist.waitFor();
  await auditPage(page, "notifications 320px");

  assert.deepEqual(errors, [], `browser page errors: ${JSON.stringify(errors)}`);
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ checks, errors, axe: Boolean(axePath), staticBase, workspaceBase }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, errors, axe: Boolean(axePath) }, null, 2));
}

main().catch(async error => {
  fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ checks, errors, message: error.message, stack: error.stack }, null, 2));
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await browser?.close();
  if (staticServer) await new Promise(resolve => staticServer.close(resolve));
});
