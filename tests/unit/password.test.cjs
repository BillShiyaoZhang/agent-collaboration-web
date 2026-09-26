const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const test = require('node:test');
const ts = require('typescript');
const bcrypt = require('bcryptjs');

function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText, filename);
  return loaded.exports;
}
const passwords = load('../../src/lib/auth/password.ts');

test('new hashes bind the entire UTF-8 password including bytes beyond the bcrypt cutoff', async () => {
  for (const prefix of ['a'.repeat(72), '中'.repeat(24)]) {
    const password = prefix + 'correct-suffix', hash = await passwords.hashPassword(password);
    assert.match(hash, /^\$scrypt\$v1\$/);
    assert.equal(await passwords.verifyPassword(password, hash), true);
    assert.equal(await passwords.verifyPassword(prefix + 'wrong-suffix', hash), false);
    assert.equal(await passwords.verifyPassword(prefix, hash), false);
    assert.equal(passwords.passwordNeedsUpgrade(hash), false);
  }
});

test('password bounds count bytes, hashes have unique salts, and malformed formats fail closed', async () => {
  const password = 'correct-horse-battery-staple';
  const [a, b] = await Promise.all([passwords.hashPassword(password), passwords.hashPassword(password)]);
  assert.notEqual(a, b); assert.equal(await passwords.verifyPassword('wrong', a), false);
  for (const value of ['', 'x'.repeat(1025), '中'.repeat(342), undefined, {}]) assert.equal(passwords.validPasswordSize(value), false);
  assert.equal(passwords.validPasswordSize('x'.repeat(1024)), true);
  assert.equal(passwords.validPasswordSize('中'.repeat(341)), true);
  await assert.rejects(passwords.hashPassword('x'.repeat(1025)), /length/);
  for (const hash of ['', '$scrypt$v99$bad', a + '$extra', '$scrypt$v1$' + 'a'.repeat(22) + '$short']) assert.equal(await passwords.verifyPassword(password, hash), false);
});

test('successful legacy login upgrades with compare-and-swap; failures and invalid input never write', async () => {
  const password = 'long-legacy-password-' + 'a'.repeat(80), legacy = await bcrypt.hash(password, 4);
  const user = { id: 'user-a', email: 'owner@example.com', passwordHash: legacy, sessionVersion: 0, requiresEmailVerification: false, emailVerifiedAt: null }, writes = [];
  let reads = 0;
  const auth = load('../../src/lib/auth/auth.ts', {
    './password': passwords,
    '@/lib/shared/db': { prisma: { user: {
      findUnique: async ({ where }) => { reads++; return where.email === user.email ? user : null; },
      updateMany: async ({ where, data }) => { writes.push({ where, data }); assert.equal(where.id, user.id); assert.equal(where.passwordHash, user.passwordHash); user.passwordHash = data.passwordHash; return { count: 1 }; },
    } } },
  });
  const authorize = auth.authOptions.providers[0].options.authorize;
  for (const credentials of [undefined, { email: user.email, password: 'x'.repeat(1025) }, { email: {}, password }, { email: user.email, password: [] }]) assert.equal(await authorize(credentials), null);
  assert.equal(reads, 0);
  assert.equal(await authorize({ email: user.email, password: 'wrong-password' }), null); assert.equal(writes.length, 0);
  assert.deepEqual(await authorize({ email: user.email, password }), { id: user.id, email: user.email, name: 'owner', sessionVersion: 0 });
  assert.equal(writes.length, 1); assert.equal(writes[0].where.passwordHash, legacy); assert.match(user.passwordHash, /^\$scrypt\$v1\$/);
  assert.equal(await passwords.verifyPassword(password.slice(0, 72) + 'changed', user.passwordHash), false);
  assert.ok(await authorize({ email: user.email, password })); assert.equal(writes.length, 1);
});
