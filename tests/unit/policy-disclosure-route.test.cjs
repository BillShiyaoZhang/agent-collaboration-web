const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");

function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}

test("policy disclosure API requires a session, same origin and the displayed policy hash", async () => {
  const oldOrigin = process.env.NEXTAUTH_URL;
  process.env.NEXTAUTH_URL = "https://console.example";
  let session = null, available = true, writes = 0, paused = false, starts = 0;
  const wakes = [];
  const hash = "a".repeat(64), current = { status: "signed", mode: "compliance", platform_id: "platform-1",
    epoch: 4, policy_hash: hash, gateway_key_id: "gateway-1", confirmed: false, paused: false,
    can_use_workbench: false, web_console_readable: true, agent_gateway_readable: true };
  class PolicyChangedError extends Error {}
  const route = load("../../src/app/api/platform-policy/route.ts", {
    "next-auth": { getServerSession: async () => session }, "@/lib/auth/auth": { authOptions: {} },
    "@/lib/control/control-protocol": { requireSameOrigin: request => {
      if (request.headers.get("origin") !== "https://console.example") throw new Error("origin");
    } },
    "@/lib/shared/http-input": load("../../src/lib/shared/http-input.ts"),
    "@/lib/workspace/workspace-store": { scheduleWorkspaceSync: async (...args) => { wakes.push(args); } },
    "@/lib/workspace/workspace-sync": { startWorkspaceSync: () => { starts++; } },
    "@/lib/control/v2-policy": { PolicyChangedError,
      readPolicyDisclosure: async userId => { assert.equal(userId, "owner"); if (!available) throw new Error("bad signature"); return current; },
      pausePolicyUse: async userId => { assert.equal(userId, "owner"); paused = true; },
      resumePolicyUse: async userId => { assert.equal(userId, "owner"); paused = false; return { ...current, paused, confirmed: true, can_use_workbench: true }; },
      confirmPolicyDisclosure: async (userId, expectedHash) => {
        assert.equal(userId, "owner"); writes++;
        if (expectedHash !== hash) throw new PolicyChangedError("policy changed");
        return { ...current, paused, confirmed: true, can_use_workbench: !paused };
      } },
  });
  const post = (body, origin = "https://console.example") => new Request("https://console.example/api/platform-policy", {
    method: "POST", headers: { origin, "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await route.GET()).status, 401);
    assert.equal((await route.POST(post({ policy_hash: hash, confirm: true }))).status, 401);
    session = { user: { id: "owner" } };
    const shown = await route.GET();
    assert.equal(shown.status, 200);
    assert.match(shown.headers.get("cache-control"), /no-store/);
    assert.equal((await shown.json()).policy_hash, hash);
    assert.equal((await route.POST(post({ policy_hash: hash, confirm: true }, "https://attacker.example"))).status, 403);
    assert.equal((await route.POST(post({ policy_hash: hash, confirm: false }))).status, 400);
    assert.equal((await route.POST(post({ policy_hash: hash, confirm: true, extra: true }))).status, 400);
    assert.equal(writes, 0);
    assert.equal((await route.POST(post({ policy_hash: "b".repeat(64), confirm: true }))).status, 409);
    assert.equal(wakes.length, 0, "stale confirmation never wakes synchronization");
    assert.equal((await route.POST(post({ policy_hash: hash, confirm: true }))).status, 200);
    assert.deepEqual(wakes, [["owner", undefined, true]]);
    assert.equal(starts, 1);
    assert.equal((await route.DELETE(new Request("https://console.example/api/platform-policy", { method: "DELETE", headers: { origin: "https://attacker.example" } }))).status, 403);
    assert.equal(paused, false);
    assert.equal((await route.DELETE(new Request("https://console.example/api/platform-policy", { method: "DELETE", headers: { origin: "https://console.example" } }))).status, 200);
    assert.equal(paused, true);
    assert.equal(wakes.length, 1, "pause never wakes synchronization");
    assert.equal((await route.POST(post({ resume: true }))).status, 200);
    assert.equal(paused, false);
    assert.deepEqual(wakes[1], ["owner", undefined, true]);
    assert.equal(starts, 2);
    available = false;
    assert.equal((await route.GET()).status, 503, "invalid policy never becomes displayable consent");
  } finally {
    if (oldOrigin === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = oldOrigin;
  }
});
