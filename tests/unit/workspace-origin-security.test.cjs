const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const Module = require('node:module'), test = require('node:test'), ts = require('typescript');
const { NextRequest } = require('next/server'), { encode } = require('next-auth/jwt');
const { AuthHandler } = require('../../node_modules/next-auth/core/index.js');
function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : name === 'server-only' ? {}
    : name.endsWith('workspace-security') ? security : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, filename);
  return loaded.exports;
}
const security = load('../../src/lib/auth/workspace-security.ts');
const { middleware } = load('../../src/middleware.ts');
const { workspacePublicConfig, validWorkspaceLaunch } = load('../../src/lib/workspace-nodes/public-config.ts');
const portal = 'https://portal.example.com', secret = 'isolated-origin-security-test-secret';
const envKeys = ['NEXTAUTH_URL', 'NEXTAUTH_SECRET', 'VERCEL', 'WORKSPACE_GATEWAY_ORIGIN_MODE', 'WORKSPACE_GATEWAY_PUBLIC_URL', 'WORKSPACE_GATEWAY_DOMAIN'];
async function configured(action, mode = 'same-site-subdomains') {
  const before = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { NEXTAUTH_URL: portal, NEXTAUTH_SECRET: secret,
    WORKSPACE_GATEWAY_ORIGIN_MODE: mode, WORKSPACE_GATEWAY_PUBLIC_URL: 'https://gateway.example.com', WORKSPACE_GATEWAY_DOMAIN: 'nodes.example.com' });
  delete process.env.VERCEL;
  try { return await action(); }
  finally { for (const key of envKeys) if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
}
const request = (pathname, headers = {}, method = 'GET') => new NextRequest(portal + pathname, { method, headers });
function allowed(response) { assert.equal(response.status, 200); assert.equal(response.headers.get('x-middleware-next'), '1'); }
function authOptions() {
  const user = { id: 'owner', sessionVersion: 0, requiresEmailVerification: false, emailVerifiedAt: null };
  return load('../../src/lib/auth/auth.ts', { './password': {}, '@/lib/shared/db': { prisma: { user: { findUnique: async () => user } } } }).authOptions;
}

test('origin mode is an exact enum; default preserves legacy cookie choices', async () => configured(async () => {
  delete process.env.WORKSPACE_GATEWAY_ORIGIN_MODE;
  assert.equal(security.workspaceOriginMode(), 'separate-site');
  assert.deepEqual(security.workspaceNextAuthCookies(), {});
  assert.equal(security.workspaceSessionCookieName(), '__Secure-next-auth.session-token');
  allowed(await middleware(request('/login', { cookie: 'legacy=value' })));
  process.env.NEXTAUTH_URL = 'http://localhost:3000';
  assert.equal(security.workspaceSessionCookieName(), 'next-auth.session-token');
  for (const invalid of ['', 'SAME-SITE-SUBDOMAINS', 'same-site', 'separate-site ']) {
    process.env.WORKSPACE_GATEWAY_ORIGIN_MODE = invalid;
    assert.throws(security.workspaceOriginMode);
    assert.throws(workspacePublicConfig);
    assert.equal((await middleware(request('/login'))).status, 503);
  }
  process.env.WORKSPACE_GATEWAY_ORIGIN_MODE = 'same-site-subdomains';
  assert.throws(security.workspaceNextAuthCookies, /HTTPS/);
}));

test('actual NextAuth uses Host cookies, ignores legacy credentials, and reads Host chunks', async () => configured(async () => {
  const options = authOptions();
  assert.equal(options.useSecureCookies, true);
  assert.equal(Object.keys(options.cookies).length, 6);
  for (const cookie of Object.values(options.cookies)) {
    assert.match(cookie.name, /^__Host-/);
    assert.deepEqual({ ...cookie.options, maxAge: undefined }, { secure: true, httpOnly: true, sameSite: 'lax', path: '/', maxAge: undefined });
    assert.equal(Object.hasOwn(cookie.options, 'domain'), false);
  }
  const call = (action, cookies = {}) => AuthHandler({ req: { action, method: 'GET', origin: portal, cookies, headers: { host: 'portal.example.com' } },
    options: { ...options, providers: [], secret, logger: { error() {}, warn() {}, debug() {} } } });
  const csrf = await call('csrf');
  assert.ok(csrf.body.csrfToken);
  assert.ok(csrf.cookies.some(cookie => cookie.name === '__Host-next-auth.csrf-token' && cookie.options.secure));
  const token = await encode({ secret, token: { sub: 'owner', id: 'owner', sessionVersion: 0, large: 'x'.repeat(9000) } });
  const name = options.cookies.sessionToken.name, chunks = token.match(/.{1,3800}/g);
  const jar = Object.fromEntries(chunks.map((chunk, index) => [name + '.' + index, chunk]).reverse());
  assert.equal((await call('session', jar)).body.user.id, 'owner');
  for (const legacy of ['__Secure-next-auth.session-token', 'next-auth.session-token']) {
    const response = await call('session', { [legacy]: token });
    assert.equal(response.body?.user, undefined);
  }
  const accepted = await middleware(request('/dashboard', { cookie: Object.entries(jar).map(([key, value]) => key + '=' + value).join('; '), 'Sec-Fetch-Site': 'same-origin' }));
  allowed(accepted);
  assert.equal(accepted.headers.get('Origin-Agent-Cluster'), '?1');
  assert.equal(accepted.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  const legacy = await middleware(request('/dashboard', { cookie: '__Secure-next-auth.session-token=' + token, 'Sec-Fetch-Site': 'same-origin' }));
  assert.equal(legacy.status, 307);
  assert.equal(new URL(legacy.headers.get('location')).pathname, '/login');
}));

test('browser perimeter precedes every public route and blocks sibling fetch/form/navigation', async () => configured(async () => {
  for (const pathname of ['/login', '/', '/api/auth/csrf', '/api/auth/callback/credentials', '/api/onboarding', '/docs/source/deploy/README.md']) {
    for (const method of ['GET', 'POST']) {
      const response = await middleware(request(pathname, { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' }, method));
      assert.equal(response.status, 403, pathname + ':' + method);
      assert.equal(response.headers.get('Origin-Agent-Cluster'), '?1');
      assert.equal(response.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
    }
  }
  for (const origin of ['https://node.nodes.example.com', 'https://other.invalid', 'null', ''])
    assert.equal((await middleware(request('/login', { Origin: origin }))).status, 403);
  for (const site of [undefined, '', 'Same-origin', 'future-value']) {
    const headers = { Cookie: 'unrelated=value' }; if (site !== undefined) headers['Sec-Fetch-Site'] = site;
    assert.equal((await middleware(request('/login', headers))).status, 403);
  }
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    assert.equal((await middleware(request('/api/auth/callback/credentials', { Cookie: 'csrf=value', 'Sec-Fetch-Site': 'same-origin' }, method))).status, 403);
    allowed(await middleware(request('/api/auth/callback/credentials', { Cookie: 'csrf=value', 'Sec-Fetch-Site': 'same-origin', Origin: portal }, method)));
  }
}));

test('address bar and safe external page links work; cross-origin API GET and unsafe none are denied', async () => configured(async () => {
  allowed(await middleware(request('/login', { Cookie: 'unrelated=value', 'Sec-Fetch-Site': 'none' })));
  const navigation = { Cookie: 'unrelated=value', 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
  allowed(await middleware(request('/login', navigation)));
  for (const pathname of ['/api/auth/csrf', '/api/auth/session', '/api/agents/one/control?request_id=known'])
    assert.equal((await middleware(request(pathname, navigation))).status, 403);
  assert.equal((await middleware(request('/login', { ...navigation, 'Sec-Fetch-Dest': 'iframe' }))).status, 403);
  assert.equal((await middleware(request('/login', { ...navigation, 'Sec-Fetch-Mode': 'cors' }))).status, 403);
  assert.equal((await middleware(request('/api/onboarding', { 'Sec-Fetch-Site': 'none' }, 'POST'))).status, 403);
  allowed(await middleware(request('/api/onboarding', { Authorization: 'Ed25519 synthetic-signature' }, 'POST')));
  allowed(await middleware(request('/api/onboarding/11111111-1111-4111-8111-111111111111', { Authorization: 'Bearer synthetic-device-token' })));
}));

test('same-site public configuration keeps hosts and every launch origin separate', async () => configured(async () => {
  assert.equal(workspacePublicConfig().gateway_url, 'https://gateway.example.com');
  assert.equal(validWorkspaceLaunch(new URL('https://node-own.nodes.example.com/_ambient/launch?ticket=fixture'), 'node-own'), true);
  for (const url of ['https://portal.example.com/_ambient/launch?ticket=x', 'https://node-other.nodes.example.com/_ambient/launch?ticket=x',
    'https://node-own.nodes.example.com/_ambient/launch?ticket=x&redirect=https://portal.example.com'])
    assert.equal(validWorkspaceLaunch(new URL(url), 'node-own'), false);
  const invalid = [
    ['https://portal.example.com', 'https://portal.example.com', 'nodes.example.com'],
    ['https://portal.example.com:444', 'https://portal.example.com', 'nodes.example.com'],
    ['https://portal.example.com', 'https://gateway.example.com', 'portal.example.com'],
    ['https://portal.nodes.example.com', 'https://gateway.example.com', 'nodes.example.com'],
    ['https://portal.example.com', 'https://nodes.example.com', 'nodes.example.com'],
    ['https://portal.example.com', 'https://gateway.example.net', 'nodes.example.net'],
    ['https://portal.example.com', 'https://gateway.example.com/ambient', 'nodes.example.com'],
    ['https://portal.example.com', 'http://gateway.example.com', 'nodes.example.com'],
    ['https://portal.example.com', 'https://' + 'a'.repeat(24) + '.nodes.example.com', 'nodes.example.com'],
  ];
  for (const [host, gateway, nodes] of invalid) {
    Object.assign(process.env, { NEXTAUTH_URL: host, WORKSPACE_GATEWAY_PUBLIC_URL: gateway, WORKSPACE_GATEWAY_DOMAIN: nodes });
    assert.throws(workspacePublicConfig, host + '|' + gateway + '|' + nodes);
  }
  Object.assign(process.env, { NEXTAUTH_URL: 'https://portal.tenant.github.io', WORKSPACE_GATEWAY_PUBLIC_URL: 'https://gateway.tenant.github.io', WORKSPACE_GATEWAY_DOMAIN: 'nodes.tenant.github.io' });
  assert.equal(workspacePublicConfig().nodeRoot, 'nodes.tenant.github.io');
  process.env.NEXTAUTH_URL = 'https://portal.other-tenant.github.io'; assert.throws(workspacePublicConfig, /registrable/);
  Object.assign(process.env, { NEXTAUTH_URL: portal, WORKSPACE_GATEWAY_PUBLIC_URL: 'https://gateway.example.com', WORKSPACE_GATEWAY_DOMAIN: 'nodes.example.com', WORKSPACE_GATEWAY_ORIGIN_MODE: 'separate-site' });
  assert.throws(workspacePublicConfig, /isolated/);
  process.env.WORKSPACE_GATEWAY_PUBLIC_URL = 'https://' + 'a'.repeat(24) + '.nodes.example.net';
  process.env.WORKSPACE_GATEWAY_DOMAIN = 'nodes.example.net';
  assert.throws(workspacePublicConfig, /node host/);
}));
