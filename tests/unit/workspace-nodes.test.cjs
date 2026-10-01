const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');

function load(relative, deps = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(deps, name) ? deps[name] : name === 'server-only' ? {} : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, filename);
  return loaded.exports;
}

test('workspace node BFF derives accounts, requires Origin, and preserves local confirmation', async () => {
  const keys = ['NEXTAUTH_URL', 'WORKSPACE_GATEWAY_URL', 'WORKSPACE_GATEWAY_SECRET'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]])), originalFetch = global.fetch;
  process.env.NEXTAUTH_URL = 'https://console.example';
  process.env.WORKSPACE_GATEWAY_URL = 'http://gateway.internal:8090';
  process.env.WORKSPACE_GATEWAY_SECRET = 'fixture-service-secret-with-at-least-32-bytes';
  let session = null, status = 'claimed', online = false, upstreamStatus = 200, malformed = false;
  const calls = [];
  const node = () => ({ node_id: 'node-own', name: 'My Ambient', status, online,
    account_id: 'owner', account_label: 'owner@example.invalid', grant_id: 'grant-test',
    scopes: ['workspace.control'], expires_at: '2033-05-18T03:33:20Z', workspace_origin: 'https://node-own.workspace.example', last_seen_at: null });
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.headers.Authorization, 'Bearer ' + process.env.WORKSPACE_GATEWAY_SECRET);
    assert.equal(options.redirect, 'error');
    const pathname = new URL(url).pathname;
    if (upstreamStatus !== 200) return Response.json({ error: 'private upstream detail ' + process.env.WORKSPACE_GATEWAY_SECRET }, { status: upstreamStatus });
    if (!pathname.startsWith('/v1/accounts/owner/')) return Response.json({ nodes: [] });
    if (pathname.includes('/nodes/foreign/')) return Response.json({ error: 'not found' }, { status: 404 });
    if (pathname.endsWith('/launch')) return status === 'paired' && online ? Response.json({ url: 'https://node-own.workspace.example/_ambient/launch?ticket=one-time', expires_at: '2033-05-18T03:33:20Z' }) : Response.json({ error: 'not ready' }, { status: 409 });
    if (options.method === 'DELETE') { status = 'revoked'; online = false; return Response.json(node()); }
    if (pathname.endsWith('/pairings/claim')) return Response.json({ ...node(), connector_token: 'MUST-NOT-REACH-BROWSER' });
    return Response.json(malformed ? { nodes: [{ ...node(), account_id: 'other' }] } : { nodes: [node()] });
  };
  const gateway = load('../../src/lib/workspace-nodes/gateway.ts');
  const input = load('../../src/lib/shared/http-input.ts');
  const origin = { requireSameOrigin(request) { if (request.headers.get('origin') !== process.env.NEXTAUTH_URL) throw new Error('origin'); } };
  const http = load('../../src/lib/workspace-nodes/http.ts', {
    'next-auth': { getServerSession: async () => session }, '@/lib/auth/auth': { authOptions: {} },
    '@/lib/control/control-protocol': origin, '@/lib/shared/http-input': input,
    '@/lib/workspace-nodes/gateway': gateway,
  });
  const deps = { '@/lib/workspace-nodes/http': http, '@/lib/workspace-nodes/gateway': gateway };
  const list = load('../../src/app/api/workspace-nodes/route.ts', deps);
  const claim = load('../../src/app/api/workspace-nodes/claim/route.ts', deps);
  const open = load('../../src/app/api/workspace-nodes/[id]/open/route.ts', deps);
  const revoke = load('../../src/app/api/workspace-nodes/[id]/route.ts', deps);
  const request = (body = {}, originValue = 'https://console.example', method = 'POST') => new Request('https://console.example/api/workspace-nodes', {
    method, headers: { Origin: originValue, 'Content-Type': 'application/json', Authorization: 'Bearer browser-forged', Cookie: 'private-cookie' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const context = id => ({ params: Promise.resolve({ id }) });
  try {
    assert.equal((await list.GET()).status, 401);
    assert.equal((await claim.POST(request({ code: 'PAIR1234' }))).status, 401);
    assert.equal(calls.length, 0);
    session = { user: { id: 'owner', email: 'owner@example.invalid' } };
    const switched = request({ code: 'PAIR1234' }); switched.headers.set('X-Workspace-Account', 'other');
    assert.equal((await claim.POST(switched)).status, 409);
    assert.equal((await claim.POST(request({ code: 'PAIR1234' }, 'https://attacker.invalid'))).status, 403);
    assert.equal((await open.POST(request({}, ''), context('node-own'))).status, 403);
    assert.equal((await revoke.DELETE(request({}, 'https://attacker.invalid', 'DELETE'), context('node-own'))).status, 403);
    for (const extra of [{ account_id: 'other' }, { label: 'another person' }, { scopes: ['workspace.manage'] }])
      assert.equal((await claim.POST(request({ code: 'PAIR1234', ...extra }))).status, 400);
    assert.equal((await claim.POST(request('x'.repeat(4097)))).status, 413);
    assert.equal((await open.POST(request({ account_id: 'other' }), context('node-own'))).status, 400);
    assert.equal((await open.POST(request({}), context('../another'))).status, 400);
    assert.equal(calls.length, 0);
    const listed = await list.GET(); assert.equal(listed.status, 200);
    assert.match(listed.headers.get('cache-control'), /private.*no-store/); assert.equal(listed.headers.get('vary'), 'Cookie');
    assert.deepEqual(await listed.json(), { nodes: [node()] });
    const claimed = await claim.POST(request({ code: 'PAIR1234' })); assert.equal(claimed.status, 200);
    assert.equal((await claimed.json()).status, 'claimed');
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { code: 'PAIR1234', label: 'owner@example.invalid' });
    assert.equal('Cookie' in calls.at(-1).options.headers, false);
    assert.equal(JSON.stringify(await gateway.claimWorkspaceNode('owner', 'PAIR1234', 'owner@example.invalid')).includes('MUST-NOT'), false);
    assert.equal((await open.POST(request(), context('node-own'))).status, 409, 'cloud claim cannot substitute local approval');
    status = 'paired'; online = true;
    const launched = await open.POST(request(), context('node-own')); assert.equal(launched.status, 200);
    assert.match((await launched.json()).url, /^https:\/\/node-own\.workspace\.example/);
    assert.equal((await open.POST(request(), context('foreign'))).status, 404);
    session = { user: { id: 'other', email: 'other@example.invalid' } };
    assert.deepEqual(await (await list.GET()).json(), { nodes: [] });
    assert.equal(calls.at(-1).url, 'http://gateway.internal:8090/v1/accounts/other/nodes');
    session = { user: { id: 'owner', email: 'owner@example.invalid' } };
    const removed = await revoke.DELETE(request({}, 'https://console.example', 'DELETE'), context('node-own'));
    assert.equal(removed.status, 200); assert.equal((await removed.json()).status, 'revoked');
    assert.equal((await open.POST(request(), context('node-own'))).status, 409);
    malformed = true; assert.equal((await list.GET()).status, 502, 'cross-account upstream data must fail closed'); malformed = false;
    upstreamStatus = 401; const failed = await list.GET(); assert.equal(failed.status, 502);
    assert.equal(JSON.stringify(await failed.json()).includes(process.env.WORKSPACE_GATEWAY_SECRET), false);
    delete process.env.WORKSPACE_GATEWAY_SECRET; assert.equal((await list.GET()).status, 503);
  } finally {
    global.fetch = originalFetch;
    for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key];
  }
});

test('workspace state text and launch eligibility reflect authorization and live connectivity', () => {
  const { workspaceNodeStatus, canOpenWorkspaceNode } = load('../../src/lib/workspace-nodes/model.ts');
  const node = { status: 'claimed', online: true, expires_at: '2033-05-18T03:33:20Z' };
  assert.equal(workspaceNodeStatus(node), '等待本机确认'); assert.equal(canOpenWorkspaceNode(node), false);
  assert.equal(workspaceNodeStatus({ ...node, status: 'paired', online: false }), '离线');
  assert.equal(canOpenWorkspaceNode({ ...node, status: 'paired', online: false }), false);
  assert.equal(canOpenWorkspaceNode({ ...node, status: 'paired' }), true);
  assert.equal(workspaceNodeStatus({ ...node, status: 'revoked' }), '已撤销');
  assert.equal(canOpenWorkspaceNode({ ...node, status: 'revoked' }), false);
  assert.equal(workspaceNodeStatus({ ...node, status: 'paired', expires_at: '1970-01-01T00:00:01Z' }), '授权已到期');
  assert.equal(canOpenWorkspaceNode({ ...node, status: 'paired', expires_at: '1970-01-01T00:00:01Z' }), false);
});
