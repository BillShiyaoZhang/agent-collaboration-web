const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const crypto = require('node:crypto');
const test = require('node:test');
const ts = require('typescript');
const { PrismaClient } = require('@prisma/client');

function load(relative, deps = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(deps, name) ? deps[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, filename);
  return loaded.exports;
}
function fingerprint(raw) {
  const bytes = crypto.createHash('sha256').update(raw).digest().subarray(0, 16);
  let n = BigInt('0x' + bytes.toString('hex')), result = '';
  while (n) { result = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Number(n % 58n)] + result; n /= 58n; }
  for (const byte of bytes) { if (byte) break; result = '1' + result; }
  return result;
}
function identity() {
  const pair = crypto.generateKeyPairSync('ed25519'), raw = pair.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { urn: 'urn:agent:test:' + fingerprint(raw), publicKey: raw.toString('hex'), signingKey: pair.privateKey, verifyKey: pair.publicKey };
}
class ControlError extends Error { constructor(message, status = 502) { super(message); this.status = status; } }

test('onboarding proves agent ownership, keeps the polling secret private, and atomically binds an explicit Web grant', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-comm-onboarding-'));
  const db = new PrismaClient({ datasources: { db: { url: 'file:' + path.join(directory, 'test.db') } } });
  const previousOrigin = process.env.NEXTAUTH_URL;
  process.env.NEXTAUTH_URL = 'https://console.example';
  try {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../prisma/remote-console.sql'), 'utf8');
    for (const statement of sql.replace(/^\s*--.*$/gm, '').split(';').filter(value => value.trim())) await db.$executeRawUnsafe(statement);
    for (const id of ['owner', 'other']) await db.user.create({ data: { id, email: id + '@example.invalid', passwordHash: 'test-hash' } });
    const agent = identity(), console = identity(), events = [];
    let session = null;
    const transport = { ControlError, consoleKeys: () => console, resolveIdentity: async urn => {
      assert.equal(urn, agent.urn); return { ed25519_pubkey: Buffer.from(agent.publicKey, 'hex').toString('base64') };
    } };
    const protocolAuth = load('../../src/lib/protocol/protocol-auth.ts', { '@/lib/protocol/proto': {} });
    const service = load('../../src/lib/control/onboarding.ts', {
      '@/lib/shared/db': { prisma: db }, '@/lib/protocol/protocol-auth': protocolAuth,
      './control-transport': transport, './console-identity': { ensureConsoleIdentity: async id => ({ id }) },
      '@/lib/workspace/workspace-store': { scheduleWorkspaceSync: async (...args) => events.push(args) },
      '@/lib/workspace/workspace-sync': { startWorkspaceSync: () => events.push('start') },
    });
    const httpInput = load('../../src/lib/shared/http-input.ts');
    const http = load('../../src/lib/control/onboarding-http.ts', {
      'next-auth': { getServerSession: async () => session }, '@/lib/auth/auth': { authOptions: {} },
      './control-transport': transport, '@/lib/shared/http-input': httpInput,
    });
    const protocol = load('../../src/lib/control/control-protocol.ts');
    const deps = { '@/lib/control/onboarding': service, '@/lib/control/onboarding-http': http,
      '@/lib/control/control-transport': transport, '@/lib/shared/http-input': httpInput, '@/lib/control/control-protocol': protocol };
    const createRoute = load('../../src/app/api/onboarding/route.ts', deps);
    const pollRoute = load('../../src/app/api/onboarding/[id]/route.ts', deps);
    const claimRoute = load('../../src/app/api/onboarding/claim/[code]/route.ts', deps);
    const secret = crypto.randomBytes(32).toString('hex');
    const requestData = { protocol: service.ONBOARDING_PROTOCOL, agent_urn: agent.urn, name: 'Hermes test',
      poll_secret_hash: crypto.createHash('sha256').update(secret).digest('hex'),
      methods: ['capabilities', 'conversation.send', 'conversation.get'], expires_at: new Date(Date.now() + 7 * 86400000).toISOString(), timestamp: Math.floor(Date.now() / 1000) };
    function signed(value = requestData) {
      const body = JSON.stringify(value);
      return { body, authorization: 'Ed25519 ' + crypto.sign(null, Buffer.from(body), agent.signingKey).toString('hex') + ':' + agent.publicKey };
    }
    const create = signed();
    assert.throws(() => service.verifyOnboardingRequest(create.body, null), { status: 401 });
    assert.throws(() => service.verifyOnboardingRequest(create.body.replace('Hermes test', 'Other agent'), create.authorization), { status: 401 });
    const forged = signed({ ...requestData, agent_urn: console.urn });
    assert.throws(() => service.verifyOnboardingRequest(forged.body, forged.authorization), { status: 401 });
    for (const invalid of [{ timestamp: requestData.timestamp - 601 }, { methods: ['conversation.send', 'conversation.send'] },
      { methods: ['arbitrary.execute'] }, { expires_at: new Date(Date.now() + 40 * 86400000).toISOString() }]) {
      const value = signed({ ...requestData, ...invalid });
      assert.throws(() => service.verifyOnboardingRequest(value.body, value.authorization), { status: 400 });
    }
    const created = await createRoute.POST(new Request('https://console.example/api/onboarding', { method: 'POST', headers: { authorization: create.authorization }, body: create.body }));
    assert.equal(created.status, 201); assert.match(created.headers.get('cache-control'), /no-store/);
    const ticket = await created.json(), code = ticket.claim_url.split('/').at(-1), context = { params: { id: ticket.request_id } }, claimContext = { params: { code } };
    assert.equal(code.length, 32); assert.ok(Date.parse(ticket.expires_at) > Date.now() + 29 * 60000);
    assert.deepEqual(await service.createOnboarding(create.body, create.authorization), ticket, 'exact retries preserve the ticket');
    const request = (data, authorization = 'Bearer ' + secret, origin = 'https://console.example') => new Request('https://console.example/api/onboarding/' + ticket.request_id,
      { method: data ? 'POST' : 'GET', headers: { authorization, origin }, ...(data ? { body: JSON.stringify(data) } : {}) });
    assert.equal((await pollRoute.GET(request(null, 'Bearer ' + code), context)).status, 401, 'public claim code cannot poll');
    assert.deepEqual(await (await pollRoute.GET(request(), context)).json(), { status: 'pending' });
    assert.equal((await pollRoute.POST(request({ status: 'completed' }), context)).status, 409, 'completion cannot bypass Web approval');
    assert.equal((await claimRoute.GET(request(), claimContext)).status, 401);
    session = { user: { id: 'owner' } };
    const preview = await (await claimRoute.GET(request(), claimContext)).json();
    assert.deepEqual(preview.methods, requestData.methods); assert.equal(preview.expires_at, requestData.expires_at);
    assert.equal(JSON.stringify(preview).includes(secret), false); assert.equal('secretHash' in preview, false);
    assert.equal((await claimRoute.POST(request({ confirm: true }, '', 'https://attacker.example'), claimContext)).status, 403);
    assert.equal((await claimRoute.POST(request({ confirm: true, methods: ['collaboration.execute'] }), claimContext)).status, 400, 'browser cannot widen the request');
    assert.equal((await claimRoute.POST(request({ confirm: false }), claimContext)).status, 400);
    const approved = await claimRoute.POST(request({ confirm: true }), claimContext);
    assert.equal(approved.status, 200); assert.equal(events.length, 0, 'reads are not dispatched before the agent applies its grant');
    const approval = await approved.json();
    assert.equal((await db.agent.findUnique({ where: { id: approval.agent_id } })).userId, 'owner');
    const polled = await service.pollOnboarding(ticket.request_id, 'Bearer ' + secret), grant = JSON.parse(polled.grant);
    assert.equal(polled.status, 'approved'); assert.equal(grant.request_id, ticket.request_id);
    assert.equal(grant.agent_urn, agent.urn); assert.equal(grant.console_urn, console.urn);
    assert.deepEqual(grant.methods, requestData.methods); assert.equal(grant.expires_at, requestData.expires_at);
    assert.ok(crypto.verify(null, Buffer.from(polled.grant), console.verifyKey, Buffer.from(polled.signature, 'hex')));
    const row = (await db.$queryRaw`SELECT * FROM "OnboardingTicket"`)[0];
    assert.equal(row.secretHash, requestData.poll_secret_hash); assert.equal(JSON.stringify(row).includes(secret), false);
    assert.deepEqual(await service.approveOnboarding(code, 'owner'), approval, 'same account approval is idempotent');
    await assert.rejects(service.approveOnboarding(code, 'other'), { status: 404 });
    await assert.rejects(service.previewOnboarding(code, 'other'), { status: 404 });
    assert.equal(await db.agent.count(), 1);
    assert.equal((await pollRoute.POST(request({ status: 'completed', methods: ['extra'] }), context)).status, 400);
    assert.equal((await pollRoute.POST(request({ status: 'completed' }), context)).status, 200);
    assert.deepEqual(events[0], ['owner', approval.agent_id]);
    assert.equal((await service.pollOnboarding(ticket.request_id, 'Bearer ' + secret)).status, 'completed');
    await db.$executeRaw`UPDATE "OnboardingTicket" SET "ticketExpiresAt" = ${Date.now() - 1}`;
    assert.equal((await service.pollOnboarding(ticket.request_id, 'Bearer ' + secret)).status, 'completed', 'approved devices retain an acknowledgement grace after claim expiry');
    assert.deepEqual(await service.completeOnboarding(ticket.request_id, 'Bearer ' + secret), { status: 'completed' });
    await db.$executeRaw`UPDATE "OnboardingTicket" SET "ticketExpiresAt" = ${Date.now() - 31 * 60000}`;
    await assert.rejects(service.previewOnboarding(code, 'owner'), { status: 404 });
    await assert.rejects(service.pollOnboarding(ticket.request_id, 'Bearer ' + secret), { status: 404 });
    const oversized = await createRoute.POST(new Request('https://console.example/api/onboarding', { method: 'POST', body: 'x'.repeat(4097) }));
    assert.equal(oversized.status, 413);
  } finally {
    if (previousOrigin === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = previousOrigin;
    await db.$disconnect(); fs.rmSync(directory, { recursive: true, force: true });
  }
});
