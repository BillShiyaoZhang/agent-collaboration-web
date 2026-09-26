// Seed only synthetic accounts in explicitly selected, existing integration databases.
// This helper never changes production registration or disables email verification.
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { parseArgs } = require("node:util");
const ts = require("typescript");
const { PrismaClient } = require("@prisma/client");
const { migrateAccountEmail } = require("../../scripts/migrate-account-email.cjs");
const root = path.resolve(__dirname, "../..");

function loadPasswords() {
  const filename = path.join(root, "src/lib/auth/password.ts");
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText, filename);
  return loaded.exports;
}

async function seedAccount({ email, password, database }) {
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.invalid$/i.test(email)) {
    throw new Error("Only synthetic .invalid email addresses may be seeded");
  }
  if (typeof password !== "string" || password.length < 8 || Buffer.byteLength(password, "utf8") > 1024) {
    throw new Error("A synthetic password of at least 8 characters and at most 1024 bytes is required");
  }
  if (typeof database !== "string" || !path.isAbsolute(database)) {
    throw new Error("An explicit absolute integration database file path is required");
  }
  const databaseFile = fs.realpathSync(database);
  const buildRoot = fs.realpathSync(path.join(root, "build"));
  const relative = path.relative(buildRoot, databaseFile);
  if (!relative || relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative) || !fs.statSync(databaseFile).isFile()) {
    throw new Error("The existing database must be inside this Web repository's build directory");
  }
  // Override inherited environment input before constructing the client; use only
  // the explicit fixture file, including if the invoking shell has DATABASE_URL.
  const databaseUrl = "file:" + databaseFile.replaceAll("\\", "/") + "?connection_limit=1";
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
  try {
    await migrateAccountEmail(db);
    const { hashPassword } = loadPasswords();
    const account = await db.user.create({ data: {
      email: email.trim().toLowerCase(),
      passwordHash: await hashPassword(password),
      emailVerifiedAt: new Date(),
      requiresEmailVerification: false,
      sessionVersion: 0,
    }, select: { id: true, email: true } });
    return account;
  } finally { await db.$disconnect(); }
}

module.exports = { seedAccount };

if (require.main === module) {
  Promise.resolve().then(() => {
    const { values } = parseArgs({ options: {
      email: { type: "string" }, password: { type: "string" }, database: { type: "string" },
    }, strict: true, allowPositionals: false });
    return seedAccount(values);
  }).then(account => process.stdout.write(JSON.stringify(account) + "\n"))
    .catch(() => { console.error("Synthetic account seed failed; use a fresh build database, .invalid email and a valid test password."); process.exitCode = 1; });
}
