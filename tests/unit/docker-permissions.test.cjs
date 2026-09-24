const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const dockerfile = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const entrypoint = fs.readFileSync(path.join(root, "docker-entrypoint.sh"), "utf8");

test("runner makes restrictive checkout files readable before UID 1001 applies migrations", () => {
  const runner = dockerfile.split(/^FROM base AS runner\s*$/m)[1];
  assert.ok(runner, "the production runner stage must exist");
  for (const source of [
    "/app/public ./public",
    "/app/.next/standalone ./",
    "/app/.next/static ./.next/static",
    "/app/prisma ./prisma",
    "/app/docker-entrypoint.sh ./",
    "/app/node_modules/prisma /opt/prisma/node_modules/prisma",
    "/app/node_modules/@prisma /opt/prisma/node_modules/@prisma",
  ]) assert.ok(runner.includes(source), `runtime COPY missing: ${source}`);

  const copies = [...runner.matchAll(/^COPY\s+.+$/gm)];
  const readable = runner.indexOf("RUN chmod -R a+rX /app /opt/prisma");
  assert.ok(readable > 0, "root-owned runtime files need read/traverse access even when source mode is 0600/0700");
  assert.ok(copies.every(copy => copy.index < readable), "a later COPY could restore restrictive checkout modes");
  assert.match(runner.slice(readable), /chmod a\+rx \/app\/docker-entrypoint\.sh/);
  assert.ok(readable < runner.indexOf("mkdir -p /app/data /app/.next/cache"), "private data must be created after public-code permissions are normalized");
  assert.ok(readable < runner.indexOf('ENTRYPOINT ["./docker-entrypoint.sh"]'));

  assert.ok(entrypoint.indexOf('su-exec nextjs:nodejs') < entrypoint.indexOf('prisma db execute --file prisma/remote-console.sql --schema prisma/schema.prisma'));
  assert.match(entrypoint, /umask 077/);
});
