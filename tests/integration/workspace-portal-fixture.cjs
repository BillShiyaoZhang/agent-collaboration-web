// Loopback-only portal with synthetic accounts and a fresh database; no model or public platform.
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const http = require("node:http"), https = require("node:https");
const { spawn } = require("node:child_process");
const { PrismaClient } = require("@prisma/client");
const { migrateAccountEmail } = require("../../scripts/migrate-account-email.cjs");
const bcrypt = require("bcryptjs");
const root = path.resolve(__dirname, "../..");
const output = path.join(root, "build/workspace-portal-preview");
fs.mkdirSync(output, { recursive: true });
const dbFile = path.join(output, "portal-" + Date.now() + ".db");
const db = new PrismaClient({ datasources: { db: { url: "file:" + dbFile.replaceAll("\\", "/") + "?connection_limit=1" } } });
let child, proxy;
const password = "Ambient-Fixture-" + crypto.randomBytes(12).toString("hex");
const port = Number(process.env.WORKSPACE_PORTAL_FIXTURE_PORT || 3310);
const certificate = process.env.WORKSPACE_PORTAL_FIXTURE_TLS_CERT;
const key = process.env.WORKSPACE_PORTAL_FIXTURE_TLS_KEY;
const tls = Boolean(certificate || key);
const nextPort = tls ? Number(process.env.WORKSPACE_PORTAL_FIXTURE_NEXT_PORT || port + 1) : port;
const base = (tls ? "https" : "http") + "://localhost:" + port;
function fixtureFile(filename) {
  const resolved = fs.realpathSync(filename), relative = path.relative(fs.realpathSync(output), resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("TLS files must be inside this fixture build directory");
  return fs.readFileSync(resolved);
}
function stop() { proxy?.close(); child?.kill(); }
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
  child = spawn(process.execPath, [path.join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(nextPort)], {
    cwd: root, windowsHide: true, stdio: "inherit", env: { ...process.env,
      DATABASE_URL: "file:" + dbFile.replaceAll("\\", "/") + "?connection_limit=1",
      NEXTAUTH_URL: base, NEXTAUTH_SECRET: crypto.randomBytes(32).toString("hex"),
      AGENT_PLATFORM_URL: "http://127.0.0.1:1", WEB_PUSH_DISABLED: "1", RESEND_API_KEY: "",
      WORKSPACE_GATEWAY_URL: process.env.WORKSPACE_GATEWAY_URL || "http://127.0.0.1:8788",
      WORKSPACE_GATEWAY_SECRET: process.env.WORKSPACE_GATEWAY_SECRET,
    },
  });
  child.on("exit", code => { proxy?.close(); process.exitCode = code || 0; });
  if (tls) {
    proxy = https.createServer({ cert: fixtureFile(certificate), key: fixtureFile(key) }, (request, response) => {
      const upstream = http.request({ hostname: "127.0.0.1", port: nextPort, path: request.url, method: request.method,
        headers: { ...request.headers, "x-forwarded-proto": "https", "x-forwarded-host": request.headers.host } }, result => {
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
      });
      upstream.on("error", () => { if (!response.headersSent) response.writeHead(502); response.end("Fixture unavailable"); });
      request.pipe(upstream); response.on("close", () => upstream.destroy());
    });
    await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(port, "127.0.0.1", resolve); });
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base + "/api/auth/csrf")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  if (!(await fetch(base + "/api/auth/csrf")).ok) throw new Error("fixture did not start");
  console.log("WORKSPACE_PORTAL_READY " + JSON.stringify({ url: base, owner: "ambient-owner@example.invalid", other: "ambient-other@example.invalid", password, pid: child.pid, database: dbFile }));
})().catch(async error => { console.error("Workspace portal fixture failed:", error.message); await db.$disconnect(); stop(); process.exitCode = 1; });
