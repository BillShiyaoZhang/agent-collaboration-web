// Real NextAuth and Gateway HTTP regression, using only a fresh loopback fixture database.
const assert = require("node:assert/strict"), path = require("node:path"), crypto = require("node:crypto");
const { seedAccount } = require("./seed-account.cjs");
const base = process.env.WORKSPACE_PORTAL_FIXTURE_URL || "http://localhost:3310";
const gateway = process.env.WORKSPACE_GATEWAY_PUBLIC_URL || process.env.WORKSPACE_GATEWAY_URL || "http://localhost:8788";
for (const value of [base, gateway]) {
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol));
  assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "fixture URLs must be loopback");
}
const database = process.env.WORKSPACE_PORTAL_FIXTURE_DATABASE;
assert.ok(database && path.isAbsolute(database), "an explicit fixture database is required");
const password = "Synthetic-" + crypto.randomBytes(18).toString("hex");
const email = "ambient-delete-" + Date.now() + "@example.invalid";
const jar = new Map();
async function browser(url, { method = "GET", body, origin = base } = {}) {
  const response = await fetch(base + url, { method, redirect: "manual",
    headers: { Origin: origin, Cookie: [...jar].map(([key, value]) => key + "=" + value).join("; "),
      ...(body instanceof URLSearchParams ? { "Content-Type": "application/x-www-form-urlencoded" } : body === undefined ? {} : { "Content-Type": "application/json" }) },
    ...(body === undefined ? {} : { body: body instanceof URLSearchParams ? body : JSON.stringify(body) }) });
  for (const cookie of response.headers.getSetCookie()) {
    const part = cookie.split(";")[0], index = part.indexOf("=");
    jar.set(part.slice(0, index), part.slice(index + 1));
  }
  return response;
}
async function device(url, token, body) {
  return fetch(gateway + url, { method: body === undefined ? "GET" : "POST", headers: {
    Authorization: "Bearer " + token, "Content-Type": "application/json",
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
(async () => {
  const account = await seedAccount({ email, password, database });
  const csrf = await (await browser("/api/auth/csrf")).json();
  const login = await browser("/api/auth/callback/credentials", { method: "POST",
    body: new URLSearchParams({ csrfToken: csrf.csrfToken, email, password, callbackUrl: base + "/dashboard/workspaces", json: "true" }) });
  assert.equal(login.status, 200);
  const session = await (await browser("/api/auth/session")).json(); assert.equal(session.user.id, account.id);
  assert.equal((await browser("/api/workspace-nodes/enroll", { method: "POST", origin: "https://foreign.invalid", body: {} })).status, 403);
  assert.equal((await browser("/api/workspace-nodes/enroll", { method: "POST", body: { account_id: "portal-owner" } })).status, 400);
  const enrollmentResponse = await browser("/api/workspace-nodes/enroll", { method: "POST", body: {} });
  assert.equal(enrollmentResponse.status, 200); const enrollment = await enrollmentResponse.json();
  assert.equal(new URL(enrollment.gateway_url).hostname, "localhost");
  const pairResponse = await fetch(gateway + "/v1/connector/pairings", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enrollment_token: enrollment.enrollment_token, name: "HTTP fixture deletion", scopes: ["workspace.control"], expires_in: 3600 }) });
  assert.equal(pairResponse.status, 200); const pair = await pairResponse.json();
  const replay = await fetch(gateway + "/v1/connector/pairings", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enrollment_token: enrollment.enrollment_token, name: "Replay fixture", scopes: ["workspace.control"], expires_in: 3600 }) });
  assert.equal(replay.status, 409, "an enrollment can create only one pairing");
  const pendingPage = await (await browser("/api/workspace-nodes?limit=1&view=active")).json();
  assert.equal(pendingPage.nodes[0].account_id, account.id); assert.equal(pendingPage.nodes[0].status, "pending");
  assert.ok(Object.hasOwn(pendingPage, "next_cursor"));
  assert.equal((await browser("/api/workspace-nodes/claim", { method: "POST", origin: "https://foreign.invalid", body: { code: pair.pairing_code } })).status, 403);
  assert.equal((await browser("/api/workspace-nodes/claim", { method: "POST", body: { code: pair.pairing_code, account_id: "portal-owner" } })).status, 400);
  const claimedResponse = await browser("/api/workspace-nodes/claim", { method: "POST", body: { code: pair.pairing_code } });
  assert.equal(claimedResponse.status, 200); const claimed = await claimedResponse.json();
  assert.equal(claimed.status, "claimed"); assert.equal(claimed.account_id, account.id); assert.equal(claimed.account_label, email);
  assert.equal("connector_token" in claimed, false);
  const approved = await device("/v1/connector/approve", pair.connector_token, { account_id: account.id, grant_id: claimed.grant_id });
  assert.equal(approved.status, 200); assert.equal((await approved.json()).status, "paired");
  const wrong = await browser("/api/auth/delete-account", { method: "POST", body: { expectedAccountId: account.id, currentPassword: "incorrect-password", confirmation: "DELETE" } });
  assert.equal(wrong.status, 400);
  assert.equal((await (await device("/v1/connector/state", pair.connector_token)).json()).status, "paired");
  const deleted = await browser("/api/auth/delete-account", { method: "POST", body: { expectedAccountId: account.id, currentPassword: password, confirmation: "DELETE" } });
  assert.equal(deleted.status, 200); assert.equal((await deleted.json()).deleted, true);
  assert.equal((await browser("/api/workspace-nodes")).status, 401, "deleted account's original cookie cannot access BFF");
  const state = await device("/v1/connector/state", pair.connector_token);
  if (state.ok) assert.equal((await state.json()).status, "revoked"); else assert.ok([401, 404, 409, 410].includes(state.status));
  const late = await device("/v1/connector/approve", pair.connector_token, { account_id: account.id, grant_id: claimed.grant_id });
  assert.ok([401, 404, 409, 410].includes(late.status), "deleted account cannot finish a concurrent local approval");
  console.log("WORKSPACE_PORTAL_SMOKE_PASS real login, origin/account isolation, local confirmation, deletion revocation and stale-cookie rejection");
})().catch(error => { console.error("Workspace portal smoke failed:", error.message); process.exitCode = 1; });
