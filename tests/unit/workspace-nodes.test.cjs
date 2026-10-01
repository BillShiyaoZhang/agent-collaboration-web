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
  const keys = ['NEXTAUTH_URL', 'WORKSPACE_GATEWAY_URL', 'WORKSPACE_GATEWAY_SECRET', 'WORKSPACE_GATEWAY_PUBLIC_URL', 'WORKSPACE_GATEWAY_DOMAIN'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]])), originalFetch = global.fetch;
  process.env.NEXTAUTH_URL = 'https://console.example.com';
  process.env.WORKSPACE_GATEWAY_URL = 'http://gateway.internal:8090';
  process.env.WORKSPACE_GATEWAY_SECRET = 'fixture-service-secret-with-at-least-32-bytes';
  process.env.WORKSPACE_GATEWAY_PUBLIC_URL = 'https://gateway.workspace.example.net';
  process.env.WORKSPACE_GATEWAY_DOMAIN = 'workspace.example.net';
  let session = null, status = 'claimed', online = false, upstreamStatus = 200, malformed = false, upstreamRetryAfter = "60";
  const calls = [];
  const node = () => ({ node_id: 'node-own', name: 'My Ambient', status, online,
    account_id: 'owner', account_label: 'owner@example.invalid', grant_id: 'grant-test',
    scopes: ['workspace.control'], expires_at: '2033-05-18T03:33:20Z', workspace_origin: 'https://node-own.workspace.example.net', last_seen_at: null });
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    assert.equal(options.headers.Authorization, 'Bearer ' + process.env.WORKSPACE_GATEWAY_SECRET);
    assert.equal(options.redirect, 'error');
    const pathname = new URL(url).pathname;
    if (upstreamStatus !== 200) return Response.json({ error: 'private upstream detail ' + process.env.WORKSPACE_GATEWAY_SECRET }, { status: upstreamStatus, headers: { 'Retry-After': upstreamRetryAfter } });
    if (!pathname.startsWith('/v1/accounts/owner/')) return Response.json({ nodes: [], next_cursor: null });
    if (pathname.endsWith('/enrollments')) return Response.json({ enrollment_token: 'E'.repeat(43), expires_at: new Date(Date.now() + 300000).toISOString(), connector_token: 'private-connector' });
    if (pathname.includes('/nodes/foreign/')) return Response.json({ error: 'not found' }, { status: 404 });
    if (pathname.endsWith('/launch')) return status === 'paired' && online ? Response.json({ url: 'https://node-own.workspace.example.net/_ambient/launch?ticket=one-time', expires_at: '2033-05-18T03:33:20Z' }) : Response.json({ error: 'not ready' }, { status: 409 });
    if (options.method === 'DELETE') { status = 'revoked'; online = false; return Response.json(node()); }
    if (pathname.endsWith('/pairings/claim')) return Response.json({ ...node(), connector_token: 'MUST-NOT-REACH-BROWSER' });
    return Response.json(malformed ? { nodes: [{ ...node(), account_id: 'other' }], next_cursor: null } : { nodes: [node()], next_cursor: null });
  };
  const publicConfig = load('../../src/lib/workspace-nodes/public-config.ts');
  const gateway = load('../../src/lib/workspace-nodes/gateway.ts', { './public-config': publicConfig });
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
  const enroll = load('../../src/app/api/workspace-nodes/enroll/route.ts', deps);
  const open = load('../../src/app/api/workspace-nodes/[id]/open/route.ts', deps);
  const revoke = load('../../src/app/api/workspace-nodes/[id]/route.ts', deps);
  const request = (body = {}, originValue = 'https://console.example.com', method = 'POST') => new Request('https://console.example.com/api/workspace-nodes', {
    method, headers: { Origin: originValue, 'Content-Type': 'application/json', Authorization: 'Bearer browser-forged', Cookie: 'private-cookie' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const context = id => ({ params: Promise.resolve({ id }) });
  try {
    assert.equal((await list.GET()).status, 401);
    assert.equal((await claim.POST(request({ code: 'PAIR1234' }))).status, 401);
    assert.equal((await enroll.POST(request())).status, 401);
    assert.equal(calls.length, 0);
    session = { user: { id: 'owner', email: 'owner@example.invalid' } };
    const switched = request({ code: 'PAIR1234' }); switched.headers.set('X-Workspace-Account', 'other');
    assert.equal((await claim.POST(switched)).status, 409);
    const changedEnroll = request(); changedEnroll.headers.set('X-Workspace-Account', 'other');
    assert.equal((await enroll.POST(changedEnroll)).status, 409);
    assert.equal((await enroll.POST(request({}, 'https://attacker.invalid'))).status, 403);
    for (const body of [{ account_id: 'other' }, { label: 'other' }, { scopes: ['workspace.manage'] }, { expires_in: 3600 }])
      assert.equal((await enroll.POST(request(body))).status, 400);
    assert.equal((await enroll.POST(request('x'.repeat(4097)))).status, 413);
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
    assert.deepEqual(await listed.json(), { nodes: [node()], next_cursor: null });
    assert.equal(calls.at(-1).url, 'http://gateway.internal:8090/v1/accounts/owner/nodes?limit=50&view=active');
    const beforeEnroll = calls.length;
    const enrollment = await enroll.POST(request()); assert.equal(enrollment.status, 200);
    assert.match(enrollment.headers.get('cache-control'), /private.*no-store/);
    const issued = await enrollment.json();
    assert.equal(issued.enrollment_token, 'E'.repeat(43)); assert.equal(issued.gateway_url, 'https://gateway.workspace.example.net');
    assert.equal('connector_token' in issued, false);
    assert.equal(calls.length, beforeEnroll + 1, 'issuance must not also claim a pairing');
    assert.match(calls.at(-1).url, /\/enrollments$/);
    assert.deepEqual(JSON.parse(calls.at(-1).options.body), { label: 'owner@example.invalid' });
    assert.equal('Cookie' in calls.at(-1).options.headers, false);
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
    assert.deepEqual(await (await list.GET()).json(), { nodes: [], next_cursor: null });
    assert.equal(calls.at(-1).url, 'http://gateway.internal:8090/v1/accounts/other/nodes?limit=50&view=active');
    session = { user: { id: 'owner', email: 'owner@example.invalid' } };
    const removed = await revoke.DELETE(request({}, 'https://console.example.com', 'DELETE'), context('node-own'));
    assert.equal(removed.status, 200); assert.equal((await removed.json()).status, 'revoked');
    assert.equal((await open.POST(request(), context('node-own'))).status, 409);
    malformed = true; assert.equal((await list.GET()).status, 502, 'cross-account upstream data must fail closed'); malformed = false;
    upstreamStatus = 429; const throttled = await enroll.POST(request());
    assert.equal(throttled.status, 429); assert.equal(throttled.headers.get('retry-after'), '60');
    assert.equal(JSON.stringify(await throttled.json()).includes(process.env.WORKSPACE_GATEWAY_SECRET), false);
    for (const value of ['0', '301', '99999999999', 'invalid-date']) {
      upstreamRetryAfter = value;
      assert.equal((await enroll.POST(request())).headers.get('retry-after'), '60', 'unsafe Retry-After falls back to a bounded cooldown');
    }
    upstreamRetryAfter = '300'; assert.equal((await enroll.POST(request())).headers.get('retry-after'), '300');
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


test('public workspace origins use the full public suffix list including private suffixes', () => {
  const keys = ['NEXTAUTH_URL', 'WORKSPACE_GATEWAY_PUBLIC_URL', 'WORKSPACE_GATEWAY_DOMAIN'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const { workspacePublicConfig, validWorkspaceLaunch } = load('../../src/lib/workspace-nodes/public-config.ts');
  const configure = (portal, control, domain) => {
    process.env.NEXTAUTH_URL = portal; process.env.WORKSPACE_GATEWAY_PUBLIC_URL = control; process.env.WORKSPACE_GATEWAY_DOMAIN = domain;
  };
  try {
    configure('https://portal.example.co.uk', 'https://gateway.workspaces.other.co.uk', 'workspaces.other.co.uk');
    assert.equal(workspacePublicConfig().gateway_url, 'https://gateway.workspaces.other.co.uk');
    assert.equal(validWorkspaceLaunch(new URL('https://node-own.workspaces.other.co.uk/_ambient/launch?ticket=fixture'), 'node-own'), true);
    for (const url of ['https://portal.example.co.uk/_ambient/launch?ticket=x',
      'https://node-foreign.workspaces.other.co.uk/_ambient/launch?ticket=x',
      'https://node-own.workspaces.other.co.uk/_ambient/launch?ticket=x&redirect=y',
      'https://node-own.workspaces.other.co.uk/elsewhere?ticket=x'])
      assert.equal(validWorkspaceLaunch(new URL(url), 'node-own'), false);
    configure('https://portal.example.co.uk', 'https://gateway.workspaces.example.co.uk', 'workspaces.example.co.uk');
    assert.throws(workspacePublicConfig, /isolated/);
    configure('https://portal.example.com', 'http://gateway.other.com', 'other.com'); assert.throws(workspacePublicConfig);
    configure('https://portal.example.com', 'https://gateway.other.com/path', 'other.com'); assert.throws(workspacePublicConfig);
    configure('https://portal.example.com', 'https://gateway.other.com', 'different.net'); assert.throws(workspacePublicConfig);
    configure('https://portal.tenant.github.io', 'https://gateway.tenant.github.io', 'nodes.tenant.github.io'); assert.throws(workspacePublicConfig);
    configure('https://portal.tenant-a.github.io', 'https://gateway.tenant-b.github.io', 'nodes.tenant-b.github.io');
    assert.equal(workspacePublicConfig().nodeRoot, 'nodes.tenant-b.github.io');
    configure('http://localhost:3000', 'http://localhost:8788', 'workspace.localhost:8788');
    assert.equal(validWorkspaceLaunch(new URL('http://node-own.workspace.localhost:8788/_ambient/launch?ticket=fixture'), 'node-own'), true);
    configure('http://localhost:3000', 'http://localhost:3000', 'workspace.localhost:3000'); assert.throws(workspacePublicConfig);
    configure('https://portal.example.com', '', 'other.com'); assert.throws(workspacePublicConfig, 'never disclose internal BFF URL as a fallback');
  } finally { for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
});

test('node pages reject excessive or ambiguous queries and check every returned owner', async () => {
  const keys = ['WORKSPACE_GATEWAY_URL', 'WORKSPACE_GATEWAY_SECRET'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]])), originalFetch = global.fetch;
  process.env.WORKSPACE_GATEWAY_URL = 'http://gateway.internal:8090';
  process.env.WORKSPACE_GATEWAY_SECRET = 'fixture-service-secret-with-at-least-32-bytes';
  const config = load('../../src/lib/workspace-nodes/public-config.ts');
  const gateway = load('../../src/lib/workspace-nodes/gateway.ts', { './public-config': config });
  const http = load('../../src/lib/workspace-nodes/http.ts', {
    'next-auth': { getServerSession: async () => ({ user: { id: 'owner' } }) }, '@/lib/auth/auth': { authOptions: {} },
    '@/lib/control/control-protocol': {}, '@/lib/shared/http-input': load('../../src/lib/shared/http-input.ts'),
    '@/lib/workspace-nodes/gateway': gateway,
  });
  const list = load('../../src/app/api/workspace-nodes/route.ts', { '@/lib/workspace-nodes/http': http, '@/lib/workspace-nodes/gateway': gateway });
  const request = query => new Request('https://portal.example.com/api/workspace-nodes' + query);
  const node = id => ({ node_id: id, name: id, status: 'pending', online: false, account_id: 'owner', account_label: null,
    grant_id: null, scopes: ['workspace.control'], expires_at: '2033-05-18T03:33:20Z', workspace_origin: 'https://' + id + '.other.com', last_seen_at: null });
  let calls = 0, malformed = false, oversized = false, missingCursor = false;
  global.fetch = async (url, options) => {
    calls++; const query = new URL(url).searchParams; assert.equal(options.method, 'GET');
    assert.equal(query.get('limit'), '1'); assert.equal(query.get('view'), 'history');
    return Response.json({ nodes: oversized ? [node('one'), node('two')] : [{ ...node(query.get('cursor') ? 'second' : 'first'), ...(malformed ? { account_id: 'other' } : {}) }],
      ...(missingCursor ? {} : { next_cursor: query.get('cursor') ? null : 'NEXT_cursor' }) });
  };
  try {
    for (const query of ['?limit=101', '?limit=0', '?limit=-1', '?limit=1&limit=2', '?view=all', '?account_id=other', '?cursor=', '?cursor=' + 'x'.repeat(2049)])
      assert.equal((await list.GET(request(query))).status, 400, query);
    assert.equal(calls, 0);
    const first = await list.GET(request('?limit=1&view=history')); assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { nodes: [node('first')], next_cursor: 'NEXT_cursor' });
    const second = await list.GET(request('?limit=1&view=history&cursor=NEXT_cursor')); assert.equal(second.status, 200);
    assert.deepEqual(await second.json(), { nodes: [node('second')], next_cursor: null });
    malformed = true; assert.equal((await list.GET(request('?limit=1&view=history'))).status, 502); malformed = false;
    oversized = true; assert.equal((await list.GET(request('?limit=1&view=history'))).status, 502); oversized = false;
    missingCursor = true; assert.equal((await list.GET(request('?limit=1&view=history'))).status, 502, 'old unbounded service responses are not silently accepted');
  } finally { global.fetch = originalFetch; for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
});

test('account revocation JSON is bounded, including chunked responses, before deletion can proceed', async () => {
  const keys = ['WORKSPACE_GATEWAY_URL', 'WORKSPACE_GATEWAY_SECRET'];
  const before = Object.fromEntries(keys.map(key => [key, process.env[key]])), originalFetch = global.fetch;
  process.env.WORKSPACE_GATEWAY_URL = 'http://gateway.internal:8090';
  process.env.WORKSPACE_GATEWAY_SECRET = 'fixture-service-secret-with-at-least-32-bytes';
  const gateway = load('../../src/lib/workspace-nodes/gateway.ts', { './public-config': load('../../src/lib/workspace-nodes/public-config.ts') });
  let cancelled = false;
  try {
    global.fetch = async () => Response.json({ revoked: 2 });
    await gateway.revokeAccountWorkspaceNodes('owner');
    global.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(131073)); }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } });
    await assert.rejects(gateway.revokeAccountWorkspaceNodes('owner'), error => error.status === 503);
    assert.equal(cancelled, true);
    cancelled = false;
    global.fetch = async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json', 'Content-Length': '131073' } });
    await assert.rejects(gateway.revokeAccountWorkspaceNodes('owner'), error => error.status === 503);
    assert.equal(cancelled, true);
    for (const body of [new Response('<html>not json</html>'), Response.json({ revoked: -1 }),
      new Response(new Uint8Array([0xff]), { headers: { 'Content-Type': 'application/json' } })]) {
      global.fetch = async () => body;
      await assert.rejects(gateway.revokeAccountWorkspaceNodes('owner'), error => error.status === 503);
    }
  } finally { global.fetch = originalFetch; for (const key of keys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
});

test('incremental pages update duplicate nodes and keep a traversable bounded browser window', () => {
  const { mergeWorkspaceNodePage } = load('../../src/lib/workspace-nodes/model.ts');
  const first = Array.from({ length: 500 }, (_, index) => ({ node_id: 'node-' + index, status: 'revoked' }));
  const merged = mergeWorkspaceNodePage(first, [{ node_id: 'node-499', status: 'expired' }, { node_id: 'node-500', status: 'expired' }]);
  assert.equal(merged.length, 500); assert.equal(merged[0].node_id, 'node-1');
  assert.equal(merged.at(-2).status, 'expired'); assert.equal(merged.at(-1).node_id, 'node-500');
});
