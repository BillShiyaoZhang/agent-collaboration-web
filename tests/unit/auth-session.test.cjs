const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');
const { encode } = require('next-auth/jwt');
const { AuthHandler } = require(path.resolve(__dirname, '../../node_modules/next-auth/core/index.js'));
function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return loaded.exports;
}
const passwords = load('../../src/lib/auth/password.ts');
function fixture(user) {
  let unavailable = false;
  const options = load('../../src/lib/auth/auth.ts', {
    './password': passwords,
    '@/lib/shared/db': { prisma: { $queryRaw: async (strings, email) => user && user.email?.toLowerCase() === email ? [{ id: user.id }] : [], user: {
      findUnique: async ({ where }) => { if (unavailable) throw new Error('database offline'); return user && (where.id === user.id || where.email === user.email) ? { ...user } : null; },
      updateMany: async () => ({ count: 0 }),
    } } },
  }).authOptions;
  return { options, fail: () => { unavailable = true; } };
}
test('new accounts require verified email while old accounts keep access without invented verification', async () => {
  const user = { id: 'owner', email: 'owner@example.com', passwordHash: await passwords.hashPassword('valid-registration-password'), sessionVersion: 0, requiresEmailVerification: true, emailVerifiedAt: null };
  const { options } = fixture(user), authorize = options.providers[0].options.authorize;
  assert.equal(await authorize({ email: user.email, password: 'wrong-password' }), null);
  await assert.rejects(authorize({ email: user.email, password: 'valid-registration-password' }), /EmailNotVerified/);
  user.requiresEmailVerification = false;
  assert.equal((await authorize({ email: user.email, password: 'valid-registration-password' })).id, user.id);
  assert.equal(user.emailVerifiedAt, null);
  user.emailVerifiedAt = new Date(); user.requiresEmailVerification = true; user.email = 'Owner@Example.com';
  assert.equal((await authorize({ email: ' OWNER@EXAMPLE.COM ', password: 'valid-registration-password' })).sessionVersion, 0);
  assert.equal((await authorize({ email: 'owner@example.com', password: 'valid-registration-password' })).id, user.id);
  assert.equal(user.email, 'Owner@Example.com');
});
test('persisted generations revoke JWTs and client session updates cannot undo revocation', async () => {
  const user = { id: 'owner', sessionVersion: 0, requiresEmailVerification: false, emailVerifiedAt: null };
  const { options, fail } = fixture(user), jwt = options.callbacks.jwt;
  const token = await jwt({ token: { id: user.id, sub: user.id } });
  assert.equal(token.sessionVersion, 0);
  user.sessionVersion = 1;
  assert.deepEqual(await jwt({ token, trigger: 'update', session: { sessionVersion: 1, id: user.id } }), { sessionRevoked: true });
  assert.deepEqual(await jwt({ token: { id: user.id } }), { sessionRevoked: true });
  const current = await jwt({ token: { id: user.id, sessionVersion: 1 } });
  assert.equal(current.id, user.id);
  fail(); assert.deepEqual(await jwt({ token: current }), { sessionRevoked: true });
  assert.equal(await options.callbacks.session({ session: { user: { email: 'owner@example.com' } }, token: { sessionRevoked: true } }), null);
});
test('NextAuth runtime returns null for an encrypted stale session cookie', async () => {
  const previous = process.env.NEXTAUTH_URL;
  process.env.NEXTAUTH_URL = 'http://localhost:3000';
  try {
    const secret = 'synthetic-account-email-session-secret';
    const user = { id: 'owner', sessionVersion: 0, requiresEmailVerification: false, emailVerifiedAt: null };
    const { options } = fixture(user);
    const cookie = await encode({ secret, token: { id: user.id, sub: user.id, email: 'owner@example.com', sessionVersion: 0 } });
    const requestSession = () => AuthHandler({ req: { action: 'session', method: 'GET', cookies: { 'next-auth.session-token': cookie }, headers: { host: 'localhost:3000' } }, options: { ...options, providers: [], secret, logger: { error() {}, warn() {}, debug() {} } } });
    assert.equal((await requestSession()).body.user.id, user.id);
    user.sessionVersion = 1;
    assert.equal((await requestSession()).body, null);
  } finally { if (previous === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = previous; }
});
