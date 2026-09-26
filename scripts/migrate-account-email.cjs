const fs = require("node:fs");
const path = require("node:path");
const { PrismaClient } = require("@prisma/client");

async function migrateAccountEmail(db) {
  await db.$transaction(async tx => {
    const columns = await tx.$queryRawUnsafe('PRAGMA table_info("User")');
    if (!columns.length) throw new Error("Run remote-console migration first");
    const additions = {
      emailVerifiedAt: 'DATETIME',
      requiresEmailVerification: 'BOOLEAN NOT NULL DEFAULT false',
      sessionVersion: 'INTEGER NOT NULL DEFAULT 0',
    };
    for (const [name, definition] of Object.entries(additions)) {
      if (!columns.some(column => column.name === name)) {
        await tx.$executeRawUnsafe(`ALTER TABLE "User" ADD COLUMN "${name}" ${definition}`);
      }
    }
    const sql = fs.readFileSync(path.resolve(__dirname, "../prisma/account-email.sql"), "utf8");
    for (const statement of sql.replace(/^\s*--.*$/gm, "").split(";").filter(value => value.trim())) {
      await tx.$executeRawUnsafe(statement);
    }
  });
}
module.exports = { migrateAccountEmail };
if (require.main === module) {
  const db = new PrismaClient();
  migrateAccountEmail(db).catch(() => {
    console.error("Account email migration failed; service startup stopped.");
    process.exitCode = 1;
  }).finally(() => db.$disconnect());
}
