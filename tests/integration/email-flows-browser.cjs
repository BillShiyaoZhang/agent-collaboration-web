// Real Chromium + Next dev email-account regression, exclusively loopback and .invalid.
// No production .env, mailbox, provider, Platform or account is used.
// PLAYWRIGHT_MODULE and CHROME_EXECUTABLE may select installed local dependencies.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { PrismaClient } = require("@prisma/client");
const { migrateAccountEmail } = require("../../scripts/migrate-account-email.cjs");
const { seedAccount } = require("./seed-account.cjs");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "build/account-email-preview", crypto.randomUUID());
fs.mkdirSync(output, { recursive: true });
const database = path.join(output, "web.db");
const db = new PrismaClient({ datasources: { db: { url: "file:" + database.replaceAll("\\", "/") + "?connection_limit=1" } } });
const checks = [], errors = [], mails = [];
const key = "resend-fixture-" + crypto.randomUUID();
let child, browser, provider, origin, nextLog = "";
const redact = text => String(text).replace(/token=[A-Za-z0-9_-]+/g, "token=[REDACTED]").replace(/(?:password|currentPassword|confirmPassword|confirmation)=[^&\s]+/gi, "password=[REDACTED]").replaceAll(key, "[SYNTHETIC_KEY]");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function freePort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function ready() {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error("Next dev stopped before becoming ready");
    try { const response = await fetch(origin + "/api/auth/csrf", { signal: AbortSignal.timeout(3000) }); if (response.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error("Next dev did not become ready");
}
async function context() {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await ctx.route("**/*", route => {
    const url = new URL(route.request().url());
    if (["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol)) return route.continue();
    errors.push("Blocked unexpected browser request to " + url.origin);
    return route.abort();
  });
  ctx.on("page", page => page.on("pageerror", error => errors.push(redact(error.stack || error.message))));
  return ctx;
}
async function login(ctx, email, password, expected = true) {
  const page = await ctx.newPage();
  await page.goto(origin + "/login?callbackUrl=%2Fdashboard%2Fsettings", { waitUntil: "domcontentloaded" });
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  const [response] = await Promise.all([
    page.waitForResponse(response => response.url().endsWith("/api/auth/callback/credentials") && response.request().method() === "POST"),
    page.getByRole("button", { name: "进入工作空间" }).click(),
  ]);
  if (expected) {
    assert.equal(response.status(), 200);
    await page.waitForURL(url => url.pathname === "/dashboard/settings");
    await page.getByRole("heading", { name: "邮箱与密码", exact: true }).waitFor();
    await page.getByText(email, { exact: true }).first().waitFor();
  } else {
    assert.equal(response.status(), 401);
    await page.getByRole("alert").filter({ hasText: "请先在邮件中验证邮箱" }).waitFor();
    assert.equal((await ctx.request.get(origin + "/api/auth/account")).status(), 401);
  }
  return page;
}
async function postClick(page, label, endpoint, status = 200) {
  const [response] = await Promise.all([
    page.waitForResponse(response => new URL(response.url()).pathname === "/api/auth/" + endpoint && response.request().method() === "POST"),
    page.getByRole("button", { name: label, exact: true }).click(),
  ]);
  assert.equal(response.status(), status, endpoint + " status");
  return response;
}
async function getTokenPage(page, url, expectedHeading) {
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  assert.equal(response.status(), 200);
  assert.equal(response.headers()["referrer-policy"], "no-referrer");
  assert.match(response.headers()["cache-control"], /no-store/);
  await page.getByRole("heading", { name: expectedHeading, exact: true }).waitFor();
  const token = new URL(url).searchParams.get("token");
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  assert.equal((await db.emailActionToken.findUnique({ where: { hash } })).consumedAt, null);
}
function mailLink(index, purpose) {
  assert.ok(mails[index], "Missing captured synthetic mail " + index);
  const url = mails[index].body.text.split("\n").find(line => line.startsWith(origin + "/"));
  assert.ok(url); assert.equal(new URL(url).pathname, "/" + purpose);
  return url;
}
async function cooldown(email, label) {
  const recent = await db.authEmailSend.findFirst({ where: { recipientHash: crypto.createHash("sha256").update(email).digest("hex") }, orderBy: { createdAt: "desc" } });
  if (!recent) return;
  const until = recent.createdAt + 60200;
  const remaining = until - Date.now();
  if (remaining > 0) console.log(label + ": waiting " + Math.ceil(remaining / 1000) + " seconds for the real recipient cooldown");
  while (Date.now() < until) await sleep(Math.min(1000, until - Date.now()));
}
async function screenshot(page, name, width = 1440) {
  await page.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
  const size = await page.evaluate(() => ({ viewport: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth, main: document.querySelector("main")?.clientWidth ?? null, content: document.querySelector("main")?.scrollWidth ?? null }));
  assert.equal(size.html, size.viewport, name + " document overflow");
  assert.equal(size.body, size.viewport, name + " body overflow");
  if (size.main !== null) assert.ok(size.content <= size.main + 1, name + " main overflow");
  await page.screenshot({ path: path.join(output, name + ".png"), fullPage: true });
  checks.push(name + ": " + width + "px without horizontal overflow");
}
async function preserved(id, urn, agentId) {
  const user = await db.user.findUnique({ where: { id } });
  assert.equal(user.virtualUrn, urn);
  assert.equal((await db.agent.findUnique({ where: { id: agentId } })).userId, id);
}
async function main() {
  const sql = fs.readFileSync(path.join(root, "prisma/remote-console.sql"), "utf8");
  for (const statement of sql.replace(/^\s*--.*$/gm, "").split(";").filter(value => value.trim())) await db.$executeRawUnsafe(statement);
  await migrateAccountEmail(db);
  const legacyEmail = "legacy-browser@example.invalid", legacyPassword = "Synthetic-Legacy-Password-2026";
  const legacy = await seedAccount({ database, email: legacyEmail, password: legacyPassword });
  const legacyUrn = "urn:hermes:agent:" + crypto.randomBytes(32).toString("hex");
  await db.user.update({ where: { id: legacy.id }, data: { emailVerifiedAt: null, requiresEmailVerification: false, virtualUrn: legacyUrn } });
  const legacyAgent = await db.agent.create({ data: { userId: legacy.id, name: "Retained synthetic connection", urn: "urn:hermes:agent:" + crypto.randomBytes(32).toString("hex"), publicKey: "00".repeat(32) } });
  provider = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/emails") { response.writeHead(404, { "content-type": "application/json" }); response.end('{"error":"isolated fixture has no Platform service"}'); return; }
    try {
      let text = ""; for await (const chunk of request) { text += chunk.toString(); if (text.length > 65536) throw new Error("Fixture body too large"); }
      const body = JSON.parse(text);
      assert.equal(request.headers.authorization, "Bearer " + key);
      assert.ok(body.to.every(email => email.endsWith(".invalid")));
      assert.equal(Object.hasOwn(body, "reply_to"), false, "transactional-only fixture has no reply mailbox");
      assert.doesNotMatch(body.text + body.html, /直接回复|人工客服/);
      assert.ok(request.headers["idempotency-key"]);
      mails.push({ body });
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ id: "synthetic-accepted-" + mails.length }));
    } catch { response.writeHead(400, { "content-type": "application/json" }); response.end('{"error":"fixture refused request"}'); }
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  const providerOrigin = "http://127.0.0.1:" + provider.address().port;
  const port = await freePort(); origin = "http://127.0.0.1:" + port;
  const env = { ...process.env,
    NODE_ENV: "development", NEXTAUTH_URL: origin, NEXTAUTH_SECRET: crypto.randomBytes(32).toString("hex"),
    DATABASE_URL: "file:" + database.replaceAll("\\", "/") + "?connection_limit=1", AGENT_PLATFORM_URL: providerOrigin,
    WORKSPACE_SYNC_DISABLED: "1", WEB_PUSH_DISABLED: "1", NEXT_TELEMETRY_DISABLED: "1",
    RESEND_API_KEY: key, AUTH_EMAIL_FROM: "Agent Comm <accounts@notify.fixture.invalid>", AUTH_EMAIL_REPLY_TO: "", NEXT_PUBLIC_SUPPORT_EMAIL: "", AUTH_EMAIL_DAILY_LIMIT: "90",
    ACCOUNT_EMAIL_FIXTURE_KEY: key, ACCOUNT_EMAIL_FIXTURE_PROVIDER: providerOrigin,
    NODE_OPTIONS: '--require "' + path.join(__dirname, "email-provider-hook.cjs").replaceAll("\\", "/") + '"',
  };
  child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "dev", "--hostname", "127.0.0.1", "--port", String(port)], { cwd: root, env, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", data => { nextLog += data.toString(); }); child.stderr.on("data", data => { nextLog += data.toString(); });
  await ready(); console.log("Isolated Next dev ready; launching real Chromium");
  browser = await chromium.launch({ headless: true, ...(process.env.CHROME_EXECUTABLE ? { executablePath: process.env.CHROME_EXECUTABLE } : {}) });
  const ctx = await context(), page = await ctx.newPage();
  const email = "email-browser@example.invalid", initialPassword = "Synthetic-Registration-Password-2026", resetPassword = "Synthetic-Reset-Password-2026", finalPassword = "Synthetic-Final-Password-2026";
  await page.goto(origin + "/register?callbackUrl=%2Fdashboard%2Fsettings", { waitUntil: "domcontentloaded" });
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  assert.equal(await page.locator('a[href^="mailto:"]').count(), 0, "unconfigured manual support stays hidden");
  await page.getByLabel("设置密码", { exact: true }).fill(initialPassword);
  await page.getByLabel("确认密码", { exact: true }).fill(initialPassword);
  await postClick(page, "创建账号", "register", 202);
  await page.getByRole("heading", { name: "请查收验证邮件" }).waitFor();
  assert.equal(mails.length, 1); await screenshot(page, "registration-desktop");
  const registered = await db.user.findUnique({ where: { email } });
  assert.equal(registered.requiresEmailVerification, true); assert.equal(registered.emailVerifiedAt, null);
  await login(ctx, email, initialPassword, false);
  checks.push("new registration cannot log in before verification");
  await getTokenPage(page, mailLink(0, "verify-email"), "验证你的邮箱");
  assert.equal((await db.user.findUnique({ where: { id: registered.id } })).emailVerifiedAt, null);
  await screenshot(page, "verification-mobile", 390);
  await postClick(page, "确认验证邮箱", "verify-email");
  await page.getByRole("link", { name: "前往登录" }).waitFor();
  assert.equal(new URL(page.url()).search, "");
  checks.push("verification GET does not consume; explicit browser POST verifies and removes the token URL");
  const settings = await login(ctx, email, initialPassword);
  await settings.getByText("邮箱已验证。", { exact: true }).waitFor();
  await screenshot(settings, "settings-desktop"); await screenshot(settings, "settings-mobile", 390);
  const preservedUrn = "urn:hermes:agent:" + crypto.randomBytes(32).toString("hex");
  await db.user.update({ where: { id: registered.id }, data: { virtualUrn: preservedUrn } });
  const agent = await db.agent.create({ data: { userId: registered.id, name: "Synthetic retained agent", urn: "urn:hermes:agent:" + crypto.randomBytes(32).toString("hex"), publicKey: "11".repeat(32) } });
  const oldSession = await context(); await login(oldSession, email, initialPassword);
  await cooldown(email, "Forgot password");
  await page.goto(origin + "/forgot-password", { waitUntil: "domcontentloaded" });
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await postClick(page, "发送重置邮件", "forgot-password", 202);
  assert.equal(mails.length, 2);
  await getTokenPage(page, mailLink(1, "reset-password"), "设置新密码");
  await page.getByLabel("新密码", { exact: true }).fill(resetPassword);
  await page.getByLabel("确认新密码", { exact: true }).fill(resetPassword);
  await postClick(page, "确认重置密码", "reset-password");
  await page.getByRole("button", { name: "使用新密码重新登录" }).waitFor();
  assert.equal((await oldSession.request.get(origin + "/api/auth/account")).status(), 401);
  assert.ok(!(await (await oldSession.request.get(origin + "/api/auth/session")).json())?.user);
  await preserved(registered.id, preservedUrn, agent.id);
  checks.push("forgot/reset through actual controls revokes old sessions and retains identity and agent rows");
  await page.getByRole("button", { name: "使用新密码重新登录" }).click();
  await page.waitForURL(url => url.pathname === "/login");
  const changed = await login(ctx, email, resetPassword);
  await cooldown(email, "Change password");
  await changed.getByLabel("当前密码", { exact: true }).fill(resetPassword);
  await changed.getByLabel("新密码", { exact: true }).fill(finalPassword);
  await changed.getByLabel("确认新密码", { exact: true }).fill(finalPassword);
  const before = await db.user.findUnique({ where: { id: registered.id } });
  await postClick(changed, "发送密码修改确认邮件", "change-password", 202);
  assert.equal(mails.length, 3);
  const pending = await db.user.findUnique({ where: { id: registered.id } });
  assert.equal(pending.passwordHash, before.passwordHash); assert.equal(pending.sessionVersion, before.sessionVersion);
  const preConfirm = await context(); await login(preConfirm, email, resetPassword);
  await getTokenPage(page, mailLink(2, "confirm-password-change"), "确认修改密码");
  const afterGet = await db.user.findUnique({ where: { id: registered.id } });
  assert.equal(afterGet.passwordHash, before.passwordHash); assert.equal(afterGet.sessionVersion, before.sessionVersion);
  assert.equal((await preConfirm.request.get(origin + "/api/auth/account")).status(), 200);
  await postClick(page, "确认修改密码", "confirm-password-change");
  await page.getByRole("button", { name: "使用新密码重新登录" }).waitFor();
  const afterConfirm = await db.user.findUnique({ where: { id: registered.id } });
  assert.equal(afterConfirm.sessionVersion, before.sessionVersion + 1); assert.notEqual(afterConfirm.passwordHash, before.passwordHash);
  assert.equal((await preConfirm.request.get(origin + "/api/auth/account")).status(), 401);
  await preserved(registered.id, preservedUrn, agent.id);
  await page.getByRole("button", { name: "使用新密码重新登录" }).click(); await page.waitForURL(url => url.pathname === "/login");
  await login(ctx, email, finalPassword);
  checks.push("change request and GET leave the old password valid; explicit confirmation changes it and revokes sessions");
  const legacyContext = await context(), legacyPage = await login(legacyContext, legacyEmail, legacyPassword);
  await legacyPage.getByText("邮箱尚未验证。已有账户可继续登录，建议补充验证，以便确认邮箱归属。", { exact: true }).waitFor();
  assert.equal(await legacyPage.getByText("邮箱已验证。", { exact: true }).count(), 0);
  await preserved(legacy.id, legacyUrn, legacyAgent.id);
  assert.equal((await db.user.findUnique({ where: { id: legacy.id } })).emailVerifiedAt, null);
  checks.push("legacy account remains usable without inventing verification; its identity and connection remain intact");
  assert.deepEqual(errors, [], "Unexpected browser errors or external requests");
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ result: "PASS", environment: "Real local Chromium, Next dev, isolated SQLite, synthetic Resend HTTP stub; no real mail or production data", checks, syntheticMailCount: mails.length, browserErrors: errors }, null, 2));
  console.log("EMAIL_BROWSER_PASS " + output);
}
main().catch(error => {
  fs.writeFileSync(path.join(output, "report.json"), JSON.stringify({ result: "FAIL", error: redact(error.stack || error.message), checks, browserErrors: errors }, null, 2));
  console.error(redact(error.stack || error.message)); process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (child && child.exitCode === null) {
    if (process.platform === "win32") {
      const stopped = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, encoding: "utf8" });
      if (stopped.status !== 0) console.error("Next fixture cleanup needs permission: PID " + child.pid + " at " + origin + "; " + (stopped.stderr || stopped.error?.message || "taskkill failed"));
    }
    else { try { process.kill(-child.pid, "SIGTERM"); } catch {} }
    await new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once("exit", resolve); setTimeout(resolve, 5000); });
  }
  child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
  fs.writeFileSync(path.join(output, "next-dev.log"), redact(nextLog));
  if (provider) { provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); }
  await db.$disconnect();
});
