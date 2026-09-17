const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');

function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return loaded.exports;
}
const input = load('../../src/lib/shared/http-input.ts');

function streamRequest(size, headers = {}) {
  let pulls = 0, cancelled = false;
  const body = new ReadableStream({
    pull(controller) { pulls++; controller.enqueue(new Uint8Array(size)); },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 });
  return { request: new Request('https://console.example/api', { method: 'POST', headers, body, duplex: 'half' }), pulls: () => pulls, cancelled: () => cancelled };
}

test('streamed input stops and cancels as soon as actual bytes exceed the limit', async () => {
  for (const headers of [{}, { 'content-length': '1' }]) {
    const source = streamRequest(2048, headers);
    await assert.rejects(input.readJsonBody(source.request, 4096), { status: 413 });
    assert.equal(source.pulls(), 3, 'must not wait for an attacker to end a chunked request');
    assert.equal(source.cancelled(), true);
  }
});

test('declared oversized bodies are rejected before reading and multibyte boundaries remain exact', async () => {
  const source = streamRequest(1, { 'content-length': '9000' });
  await assert.rejects(input.readJsonBody(source.request, 4096), { status: 413 });
  assert.equal(source.pulls(), 0); assert.equal(source.cancelled(), true);
  const value = JSON.stringify({ text: '汉字🙂' }), bytes = Buffer.from(value);
  const body = new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  assert.deepEqual(await input.readJsonBody(new Request('https://console.example', { method: 'POST', body, duplex: 'half' }), bytes.length), { text: '汉字🙂' });
  await assert.rejects(input.readJsonBody(new Request('https://console.example', { method: 'POST', body: value }), bytes.length - 1), { status: 413 });
  await assert.rejects(input.readJsonBody(new Request('https://console.example', { method: 'POST', body: '{' }), 10), { status: 400 });
});

test('NextAuth POST bounds the stream before its parser and preserves normal form data and request context', async () => {
  const calls = [];
  const handler = async (request, context) => {
    calls.push({ query: request.nextUrl.searchParams.get('callbackUrl'), cookie: request.headers.get('cookie'), context, form: Object.fromEntries(await request.formData()) });
    return Response.json({ ok: true });
  };
  const route = load('../../src/app/api/auth/[...nextauth]/route.ts', { 'next-auth': () => handler, '@/lib/auth/auth': { authOptions: {} }, '@/lib/shared/http-input': input });
  const context = { params: Promise.resolve({ nextauth: ['callback', 'credentials'] }) };
  const alias = streamRequest(8192);
  assert.equal((await route.POST(alias.request, { params: Promise.resolve({ nextauth: ['callback', 'credentials', 'bypass-rate-limit'] }) })).status, 404);
  assert.equal(alias.pulls(), 0); assert.equal(calls.length, 0);
  const oversized = streamRequest(8192);
  assert.equal((await route.POST(oversized.request, context)).status, 413);
  assert.equal(oversized.pulls(), 3); assert.equal(oversized.cancelled(), true); assert.equal(calls.length, 0);
  const { NextRequest } = require('next/server');
  const request = new NextRequest('https://console.example/api/auth/callback/credentials?callbackUrl=%2Fdashboard', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'next-auth.csrf-token=test' }, body: new URLSearchParams({ email: 'a@example.com', password: 'long-safe-password', csrfToken: 'test', json: 'true' }) });
  assert.equal((await route.POST(request, context)).status, 200);
  assert.equal(calls[0].query, '/dashboard'); assert.equal(calls[0].cookie, 'next-auth.csrf-token=test');
  assert.strictEqual(calls[0].context, context); assert.equal(calls[0].form.csrfToken, 'test'); assert.equal(calls[0].form.password, 'long-safe-password');
});

test('public registration rejects oversized streams, malformed JSON and overlong passwords before database or hashing', async () => {
  const calls = [];
  const passwords = load('../../src/lib/auth/password.ts');
  const route = load('../../src/app/api/auth/register/route.ts', {
    '@/lib/auth/password': passwords, '@/lib/shared/http-input': input,
    '@/lib/auth/auth': { hashPassword: async () => { calls.push('hash'); return 'hash'; } },
    '@/lib/shared/db': { prisma: { user: { findUnique: async () => { calls.push('find'); return null; }, create: async ({ data }) => { calls.push('create'); return { id: 'user', email: data.email }; } } } },
  });
  const source = streamRequest(8192);
  assert.equal((await route.POST(source.request)).status, 413); assert.equal(source.pulls(), 3);
  const req = body => new Request('https://console.example/api/auth/register', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });
  assert.equal((await route.POST(req('{'))).status, 400);
  assert.equal((await route.POST(req({ email: 'a@example.com', password: '中'.repeat(342) }))).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await route.POST(req({ email: 'a@example.com', password: 'valid-safe-password' }))).status, 201);
  assert.deepEqual(calls, ['find', 'hash', 'create']);
});

test('saving an agent connection enforces body limits before registry or persistence access', async () => {
  const calls = [];
  class ControlError extends Error { constructor(message, status) { super(message); this.status = status; } }
  const route = load('../../src/app/api/agents/route.ts', {
    'next-auth': { getServerSession: async () => ({ user: { id: 'owner' } }) }, '@/lib/auth/auth': { authOptions: {} },
    '@/lib/shared/http-input': input, '@/lib/control/control-protocol': load('../../src/lib/control/control-protocol.ts'),
    '@/lib/shared/db': { prisma: { agent: { create: async () => { calls.push('create'); return { id: 'agent' }; } } } },
    '@/lib/control/control-transport': { ControlError, resolveIdentity: async () => { calls.push('resolve'); return { ed25519_pubkey: Buffer.alloc(32).toString('base64') }; } },
    '@/lib/workspace/workspace-store': { scheduleWorkspaceSync: async () => calls.push('sync') },
    '@/lib/workspace/workspace-sync': { startWorkspaceSync: () => calls.push('start') },
  });
  const previous = process.env.NEXTAUTH_URL; process.env.NEXTAUTH_URL = 'https://console.example';
  try {
    const source = streamRequest(2048, { origin: 'https://console.example' });
    assert.equal((await route.POST(source.request)).status, 413); assert.equal(source.pulls(), 3); assert.equal(source.cancelled(), true);
    assert.deepEqual(calls, []);
    const request = new Request('https://console.example/api/agents', { method: 'POST', headers: { origin: 'https://console.example' }, body: JSON.stringify({ name: 'safe agent', urn: 'urn:agent:test' }) });
    assert.equal((await route.POST(request)).status, 201); assert.deepEqual(calls, ['resolve', 'create', 'sync', 'start']);
  } finally { if (previous === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = previous; }
});

test('an unregistered local URN is saved pending but invalid identity signatures still fail closed', async () => {
  class ControlError extends Error { constructor(message, status = 502, platformStatus) { super(message); this.status = status; this.platformStatus = platformStatus; } }
  let failure = new ControlError('not registered', 502, 404), saved;
  const route = load('../../src/app/api/agents/route.ts', {
    'next-auth': { getServerSession: async () => ({ user: { id: 'owner' } }) }, '@/lib/auth/auth': { authOptions: {} },
    '@/lib/shared/http-input': input, '@/lib/control/control-protocol': load('../../src/lib/control/control-protocol.ts'),
    '@/lib/shared/db': { prisma: { agent: { create: async ({ data }) => { saved = data; return { id: 'pending', ...data }; } } } },
    '@/lib/control/control-transport': { ControlError, resolveIdentity: async () => { throw failure; } },
    '@/lib/workspace/workspace-store': { scheduleWorkspaceSync: async () => {} }, '@/lib/workspace/workspace-sync': { startWorkspaceSync() {} },
  });
  const previous = process.env.NEXTAUTH_URL; process.env.NEXTAUTH_URL = 'https://console.example';
  const request = urn => new Request('https://console.example/api/agents', { method: 'POST', headers: { origin: 'https://console.example' }, body: JSON.stringify({ name: 'local agent', urn }) });
  try {
    assert.equal((await route.POST(request('urn:agent:local'))).status, 201); assert.equal(saved.platformRegistered, false); assert.equal(saved.publicKey, '');
    saved = null; failure = new ControlError('signature invalid'); assert.equal((await route.POST(request('urn:agent:local'))).status, 502); assert.equal(saved, null);
    assert.equal((await route.POST(request('not a valid urn'))).status, 400);
  } finally { if (previous === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = previous; }
});
