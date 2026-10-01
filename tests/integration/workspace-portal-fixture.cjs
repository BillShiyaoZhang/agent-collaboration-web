// Loopback-only portal with synthetic accounts and a fresh database; no model or public platform.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const http = require("node:http"), https = require("node:https");
const { spawn } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const { migrateAccountEmail } = require("../../scripts/migrate-account-email.cjs");
const bcrypt = require("bcryptjs");
const root = path.resolve(__dirname, "../..");
const outputRoot = path.join(root, "build/workspace-portal-preview");
fs.mkdirSync(outputRoot, { recursive: true });
const output = path.resolve(process.env.WORKSPACE_PORTAL_FIXTURE_OUTPUT_DIR || outputRoot);
const lexicalOutputRelative = path.relative(outputRoot, output);
if (lexicalOutputRelative.startsWith("..") || path.isAbsolute(lexicalOutputRelative))
  throw new Error("Fixture output must be inside its build directory");
fs.mkdirSync(output, { recursive: true });
const outputRelative = path.relative(fs.realpathSync(outputRoot), fs.realpathSync(output));
if (outputRelative.startsWith("..") || path.isAbsolute(outputRelative))
  throw new Error("Fixture output must be inside its build directory");
const dbFile = process.env.WORKSPACE_PORTAL_FIXTURE_DATABASE_PATH || path.join(output, "portal-" + crypto.randomUUID() + ".db");
const dbParent = fs.realpathSync(path.dirname(dbFile)), dbRelative = path.relative(fs.realpathSync(output), dbParent);
if (dbRelative.startsWith("..") || path.isAbsolute(dbRelative) || fs.existsSync(dbFile))
  throw new Error("Fixture database must be new and inside its build directory");
const db = new PrismaClient({ datasources: { db: { url: "file:" + dbFile.replaceAll("\\", "/") + "?connection_limit=1" } } });
let child, proxy, auditFd;
const password = "Ambient-Fixture-" + crypto.randomBytes(12).toString("hex");
const port = Number(process.env.WORKSPACE_PORTAL_FIXTURE_PORT || 3310);
const certificate = process.env.WORKSPACE_PORTAL_FIXTURE_TLS_CERT;
const key = process.env.WORKSPACE_PORTAL_FIXTURE_TLS_KEY;
const tls = Boolean(certificate || key);
const auditPath = process.env.WORKSPACE_PORTAL_FIXTURE_REQUEST_AUDIT_PATH;
if (auditPath && !tls) throw new Error("Request audit requires the HTTPS fixture proxy");
if (auditPath) {
  const resolved = path.resolve(auditPath), lexicalRelative = path.relative(output, resolved);
  if (!lexicalRelative || lexicalRelative.startsWith("..") || path.isAbsolute(lexicalRelative))
    throw new Error("Fixture request audit must be new and inside this fixture output directory");
  const parentRelative = path.relative(fs.realpathSync(output), fs.realpathSync(path.dirname(resolved)));
  if (parentRelative.startsWith("..") || path.isAbsolute(parentRelative) || fs.existsSync(resolved))
    throw new Error("Fixture request audit must be new and inside this fixture output directory");
  auditFd = fs.openSync(resolved, "wx", 0o600);
}
let auditRecords = 0;
function auditRequest(request) {
  if (auditFd === undefined) return;
  if (++auditRecords > 10000) throw new Error("Fixture request audit limit exceeded");
  const metadata = (name, allowed) => {
    const value = request.headers[name];
    return value === undefined ? null : allowed.includes(value) ? value : "invalid";
  };
  let pathname;
  try { pathname = new URL(request.url, "https://localhost").pathname.slice(0, 2048); }
  catch { pathname = "invalid"; }
  const cookie = request.headers.cookie || "";
  fs.writeSync(auditFd, JSON.stringify({
    path: pathname,
    site: metadata("sec-fetch-site", ["same-origin", "same-site", "cross-site", "none"]),
    mode: metadata("sec-fetch-mode", ["navigate", "same-origin", "no-cors", "cors", "websocket"]),
    dest: metadata("sec-fetch-dest", ["audio", "audioworklet", "document", "embed", "empty", "fencedframe", "font", "frame", "iframe", "image", "manifest", "object", "paintworklet", "report", "script", "serviceworker", "sharedworker", "style", "track", "video", "webidentity", "worker", "xslt"]),
    hasCookie: Boolean(cookie),
    hasHostSessionCookie: /(?:^|;\s*)__Host-next-auth\.session-token(?:\.\d+)?=/.test(cookie),
  }) + "\n");
}
function closeAudit() { if (auditFd !== undefined) { fs.closeSync(auditFd); auditFd = undefined; } }
const nextPort = tls ? Number(process.env.WORKSPACE_PORTAL_FIXTURE_NEXT_PORT || port + 1) : port;
const fixtureHost = process.env.WORKSPACE_PORTAL_FIXTURE_HOST || "localhost";
if (!/^(?:localhost|[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.(?:test|localhost|example\.(?:com|net|org)))$/.test(fixtureHost)
    || fixtureHost.includes("..") || fixtureHost.split(".").some(label => label.length > 63 || label.startsWith("-") || label.endsWith("-")))
  throw new Error("Fixture hostname must be localhost or a reserved synthetic hostname");
if (fixtureHost !== "localhost" && !tls) throw new Error("Synthetic fixture hostnames require HTTPS");
const base = (tls ? "https" : "http") + "://" + fixtureHost + ":" + port;
const publicHost = new URL(base).host;
function fixtureFile(filename) {
  const resolved = fs.realpathSync(filename), relative = path.relative(fs.realpathSync(output), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("TLS files must be inside this fixture build directory");
  return fs.readFileSync(resolved);
}
function stop() { proxy?.close(); child?.kill(); closeAudit(); }
process.on("SIGINT", stop); process.on("SIGTERM", stop);
(async () => {
  if (!process.env.WORKSPACE_GATEWAY_SECRET) throw new Error("Set the isolated Gateway service secret at runtime");
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || !Number.isInteger(nextPort) || nextPort < 1024 || nextPort > 65535) throw new Error("Invalid loopback fixture port");
  if (tls && (!certificate || !key || nextPort === port)) throw new Error("TLS requires fixture certificate, key and a distinct internal port");
  const sql = fs.readFileSync(path.join(root, "prisma/remote-console.sql"), "utf8");
  for (const statement of sql.replace(/^\s*--.*$/gm, "").split(";").filter(value => value.trim()))
    await db.$executeRawUnsafe(statement);
  await migrateAccountEmail(db);
  const passwordHash = await bcrypt.hash(password, 10);
  for (const [id, email] of [["portal-owner", "ambient-owner@example.invalid"], ["portal-other", "ambient-other@example.invalid"]])
    await db.user.create({ data: { id, email, passwordHash, requiresEmailVerification: false, emailVerifiedAt: new Date() } });
  await db.$disconnect();
  const nextCwd = process.env.WORKSPACE_PORTAL_FIXTURE_NEXT_CWD || root;
  if (nextCwd !== root) {
    const resolved = fs.realpathSync(nextCwd), relative = path.relative(fs.realpathSync(output), resolved);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Fixture Next cwd must be inside its build directory");
  }
  for (const name of [".env", ".env.local", ".env.production", ".env.production.local", ".env.development", ".env.development.local", ".env.test", ".env.test.local"])
    if (fs.existsSync(path.join(nextCwd, name))) throw new Error("Refusing to load existing dotenv files; use an isolated fixture Next cwd");
  child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], {
    cwd: nextCwd, windowsHide: true, stdio: "inherit", env: { ...process.env,
      DATABASE_URL: "file:" + dbFile.replaceAll("\\", "/") + "?connection_limit=1",
      NEXTAUTH_URL: base, NEXTAUTH_SECRET: crypto.randomBytes(32).toString("hex"),
      AGENT_PLATFORM_URL: "http://127.0.0.1:1", WEB_PUSH_DISABLED: "1", RESEND_API_KEY: "",
      WORKSPACE_GATEWAY_URL: process.env.WORKSPACE_GATEWAY_URL || "http://127.0.0.1:8788",
      WORKSPACE_GATEWAY_SECRET: process.env.WORKSPACE_GATEWAY_SECRET,
      WORKSPACE_GATEWAY_PUBLIC_URL: process.env.WORKSPACE_GATEWAY_PUBLIC_URL || "http://localhost:8788",
      WORKSPACE_GATEWAY_DOMAIN: process.env.WORKSPACE_GATEWAY_DOMAIN || "localhost:8788",
    },
  });
  child.on("exit", code => { proxy?.close(); closeAudit(); process.exitCode = code || 0; });
  if (tls) {
    proxy = https.createServer({ cert: fixtureFile(certificate), key: fixtureFile(key) }, (request, response) => {
      try { auditRequest(request); }
      catch { response.writeHead(503); response.end("Fixture request audit unavailable"); stop(); return; }
      if (request.headers.host !== publicHost) { response.writeHead(421); response.end("Fixture host mismatch"); return; }
      const upstream = http.request({ hostname: "127.0.0.1", port: nextPort, path: request.url, method: request.method,
        headers: { ...request.headers, "x-forwarded-proto": "https", "x-forwarded-host": request.headers.host } }, result => {
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("Fixture unavailable"); });
      request.pipe(upstream); response.on("close", () => upstream.destroy());
    });
    await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(port, "127.0.0.1", resolve); });
  }
  // Probe the loopback backend with the public Host. No DNS mapping or cookie
  // transport is needed, including when the public HTTPS name is synthetic.
  const ready = () => fetch("http://127.0.0.1:" + nextPort + "/api/auth/csrf", {
    headers: { Host: publicHost, "X-Forwarded-Host": publicHost, "X-Forwarded-Proto": tls ? "https" : "http" },
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await ready()).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!(await ready()).ok) throw new Error("fixture did not start");
  console.log("WORKSPACE_PORTAL_READY " + JSON.stringify({ url: base, owner: "ambient-owner@example.invalid", other: "ambient-other@example.invalid", ...(process.env.WORKSPACE_PORTAL_FIXTURE_HIDE_PASSWORD === "1" ? {} : { password }), pid: child.pid, database: dbFile }));
})().catch(async error => { console.error("Workspace portal fixture failed:", error.message); await db.$disconnect(); stop(); process.exitCode = 1; });
