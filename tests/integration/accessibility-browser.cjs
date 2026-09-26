// Manual accessibility regression check for the public Next pages and authenticated workspace.
//
// Use the loopback-only workspace-fixture.cjs to serve the built Next app.
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
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
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
    // Inline links in Markdown prose use the target-size exception for text in a sentence.
    if (element.tagName === "A" && element.closest("#reader-content") && style.display === "inline") return false;
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
  // Scan the settled colors, not a partially transparent page-enter frame.
  await page.evaluate(async () => {
    const animations = [...document.querySelectorAll(".page-enter")].flatMap(element => element.getAnimations());
    await Promise.all(animations.map(animation => animation.finished.catch(() => {})));
  });
  if (!await page.evaluate(() => Boolean(window.axe))) await page.addScriptTag({ path: axePath });
  const violations = await page.evaluate(async () => {
    const result = await window.axe.run(document, { runOnly: ["color-contrast"] });
    return result.violations.map(item => ({ id: item.id, impact: item.impact,
      nodes: item.nodes.map(node => ({ target: node.target, html: node.html.slice(0, 180), reason: node.failureSummary })) }));
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

async function login(page) {
  await page.goto(`${workspaceBase}/login?callbackUrl=/dashboard/agents`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("邮箱", { exact: true }).fill("owner-a@workspace.invalid");
  await page.getByLabel("密码", { exact: true }).fill("Workspace-smoke-fixture-2026");
  await page.getByRole("button", { name: "进入工作空间", exact: true }).click();
  await page.waitForURL("**/dashboard/agents");
}

async function main() {
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  page.on("pageerror", error => errors.push(error.message));

  await page.goto(`${workspaceBase}/`, { waitUntil: "networkidle" });
  await page.locator('header a[href^="/docs"]').first().waitFor();
  assert.equal(await page.locator('header a[href="/"]').count() > 0, true, "public navigation must return home");
  assert.equal(await page.locator('header a[href="/dashboard"]').count() > 0, true, "public navigation must reach the workspace");
  await auditPage(page, "public home desktop");
  await page.evaluate(() => { window.__publicNavState = "same-document"; });
  await page.locator('header a[href^="/docs"]').first().click();
  await page.waitForURL(url => /^\/docs\/?$/.test(url.pathname));
  assert.equal(await page.evaluate(() => window.__publicNavState), "same-document", "home to docs should use in-app navigation");
  assert.equal(await page.title(), "文档 / Documentation · Agent Comm", "docs title should not duplicate the app name");
  await auditPage(page, "public docs desktop");
  checks.push("home and docs share the Next app navigation without reloading the document");
  await page.getByRole("link", { name: "阅读用户指南 →", exact: true }).click();
  await page.locator("#reader-content h1").waitFor();
  assert.equal(new URL(page.url()).searchParams.get("path"), "deploy/users/README.md");
  assert.equal(await page.locator("#reader-raw").getAttribute("href"), "/docs/source/deploy/users/README.md");
  await auditPage(page, "public docs reader desktop");
  const publicSource = await context.request.get(`${workspaceBase}/docs/source/platform/guides/API.md`);
  assert.equal(publicSource.status(), 200, "published API guide should load from the same Next app");
  assert.match(publicSource.headers()["content-type"] || "", /^text\/plain/i);
  for (const key of ["deploy/testing/RETEST_PLAN_2026-09-24.md", "sdk/architecture/CAPABILITY_SKILL_MAP.md", "deploy/.env.md", "toString/README.md"]) {
    const response = await context.request.get(`${workspaceBase}/docs/source/${key}`);
    assert.equal(response.status(), 404, `unpublished source must be hidden: ${key}`);
  }
  await page.goto(`${workspaceBase}/docs/?path=deploy%2Ftesting%2FRETEST_PLAN_2026-09-24.md`, { waitUntil: "domcontentloaded" });
  await page.getByText("此文档不在公开指南中。", { exact: true }).waitFor();
  assert.equal(await page.locator("#reader-content").count(), 0);
  await page.locator('header a[href="/dashboard"]').click();
  await page.waitForURL(/\/login\?/);
  assert.equal(new URL(page.url()).searchParams.get("callbackUrl"), "/dashboard", "docs workspace link should preserve the requested destination");
  checks.push("published guides render in the app; private source files stay unavailable; docs workspace navigation reaches login with its destination");
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto(`${workspaceBase}/`, { waitUntil: "domcontentloaded" });
  await auditPage(page, "public home 320px");
  await page.getByRole("button", { name: "EN", exact: true }).click();
  await assertNoOverflow(page, "public home 320px in English");
  await assertTouchTargets(page, "public home 320px in English");
  await page.goto(`${workspaceBase}/docs/`, { waitUntil: "domcontentloaded" });
  await auditPage(page, "public docs 320px");
  await page.waitForFunction(() => document.querySelector('button[lang="en"]')?.getAttribute("aria-pressed") === "true");
  assert.match(await page.getByRole("heading", { level: 1 }).textContent(), /^[A-Za-z]/, "English navigation should show English content");
  assert.equal(await page.title(), "文档 / Documentation · Agent Comm");
  await assertNoOverflow(page, "public docs 320px in English");
  await assertTouchTargets(page, "public docs 320px in English");
  checks.push("public home and docs remain usable at 320px in both languages");

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
  const policyDetails = page.getByRole("button", { name: "查看详情与控制", exact: true });
  await policyDetails.waitFor();
  assert.equal(await policyDetails.getAttribute("aria-expanded"), "false", "usable policy details should start collapsed");
  assert.equal(await page.locator("#policy-details").count(), 0);
  await policyDetails.click();
  assert.equal(await page.getByRole("button", { name: "收起详情", exact: true }).getAttribute("aria-expanded"), "true");
  await page.getByRole("button", { name: "收起详情", exact: true }).click();
  assert.equal(await page.locator("#policy-details").count(), 0);
  checks.push("verified policy summary stays visible while optional details can be opened and closed");

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
  const connectionSettings = page.getByRole("button", { name: "连接设置", exact: true });
  assert.equal(await connectionSettings.getAttribute("aria-expanded"), "false", "connected workbench settings should start collapsed");
  assert.equal(await page.locator("#pairing-panel").getAttribute("hidden"), "", "successful pairing should not dominate the workbench");
  await connectionSettings.click();
  await page.getByRole("region", { name: "控制台配对", exact: true }).waitFor();
  await connectionSettings.click();
  assert.equal(await connectionSettings.getAttribute("aria-expanded"), "false");
  checks.push("connected workbench keeps pairing details behind the connection settings control");
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
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ checks, errors, axe: Boolean(axePath), workspaceBase }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, checks, errors, axe: Boolean(axePath) }, null, 2));
}

main().catch(async error => {
  fs.writeFileSync(path.join(output, "failure.json"), JSON.stringify({ checks, errors, message: error.message, stack: error.stack }, null, 2));
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  await browser?.close();
});
