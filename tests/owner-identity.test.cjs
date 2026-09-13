const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

const routePath = path.resolve(__dirname, "../src/app/api/agents/[id]/bind-owner/route.ts");

function loadRoute({ session, agent = { id: "my-agent" }, identity = null }) {
  const calls = [];
  const routeModule = new Module(routePath, module);
  routeModule.filename = routePath;
  routeModule.paths = Module._nodeModulePaths(path.dirname(routePath));
  routeModule.require = (name) => {
    if (name === "next-auth") return { getServerSession: async () => session };
    if (name === "@/lib/auth") return { authOptions: {} };
    if (name === "@/lib/crypto") return {};
    if (name === "@/lib/db") return {
      prisma: {
        agent: { findFirst: async (query) => { calls.push(["agent", query]); return agent; } },
        user: { findUnique: async (query) => { calls.push(["user", query]); return identity; } },
      },
    };
    return Module.prototype.require.call(routeModule, name);
  };
  const compiled = ts.transpileModule(fs.readFileSync(routePath, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    fileName: routePath,
  });
  routeModule._compile(compiled.outputText, routePath);
  return { GET: routeModule.exports.GET, calls };
}

const request = new Request("https://example.test/api/agents/my-agent/bind-owner");
const params = { params: { id: "my-agent" } };
const session = { user: { id: "owner" } };

test("public owner identity requires a session before accessing the database", async () => {
  const { GET, calls } = loadRoute({ session: null });
  assert.equal((await GET(request, params)).status, 401);
  assert.deepEqual(calls, []);
});

test("public owner identity requires ownership of the requested agent", async () => {
  const { GET, calls } = loadRoute({ session, agent: null });
  assert.equal((await GET(request, params)).status, 404);
  assert.deepEqual(calls, [["agent", {
    where: { id: "my-agent", userId: "owner" }, select: { id: true },
  }]]);
});

test("public owner identity selects only public fields and disables caching", async () => {
  const identity = { virtualUrn: "urn:agent:owner", virtualEd25519PublicKey: "ed-public", virtualX25519PublicKey: "x-public" };
  const { GET, calls } = loadRoute({ session, identity });
  const response = await GET(request, params);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), identity);
  assert.deepEqual(calls[1], ["user", {
    where: { id: "owner" },
    select: { virtualUrn: true, virtualEd25519PublicKey: true, virtualX25519PublicKey: true },
  }]);
});

test("reading an uninitialized identity returns null fields without writing", async () => {
  const identity = { virtualUrn: null, virtualEd25519PublicKey: null, virtualX25519PublicKey: null };
  const { GET, calls } = loadRoute({ session, identity });
  const response = await GET(request, params);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), identity);
  assert.equal(calls.length, 2);
});
