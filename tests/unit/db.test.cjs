const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

test('production route and instrumentation bundles share one Prisma pool', () => {
  const filename = path.resolve(__dirname, '../../src/lib/shared/db.ts');
  const hadClient = Object.hasOwn(globalThis, 'prisma'), savedClient = globalThis.prisma;
  const savedMode = process.env.NODE_ENV;
  let created = 0;
  class PrismaClient { constructor() { created++; } }
  const load = () => {
    const loaded = new Module(filename, module);
    loaded.filename = filename;
    loaded.paths = Module._nodeModulePaths(path.dirname(filename));
    loaded.require = name => name === '@prisma/client' ? { PrismaClient } : Module.prototype.require.call(loaded, name);
    loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText, filename);
    return loaded.exports.prisma;
  };
  try {
    delete globalThis.prisma;
    process.env.NODE_ENV = 'production';
    assert.strictEqual(load(), load());
    assert.equal(created, 1);
  } finally {
    if (hadClient) globalThis.prisma = savedClient; else delete globalThis.prisma;
    if (savedMode === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = savedMode;
  }
});
