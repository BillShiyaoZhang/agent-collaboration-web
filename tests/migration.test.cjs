const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {PrismaClient} = require("@prisma/client");

test("additive migration preserves old accounts and business rows, and supports new RPC cache",async()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),"agent-comm-web-migration-"));
  const filename=path.join(directory,"test.db");
  const db=new PrismaClient({datasources:{db:{url:"file:"+filename.replaceAll("\\","/")}}});
  try {
    const sql=fs.readFileSync(path.resolve(__dirname,"../prisma/remote-console.sql"),"utf8");
    const migrate=async()=>{for(const statement of sql.replace(/^\s*--.*$/gm, "").split(";").filter(value=>value.trim()))await db.$executeRawUnsafe(statement);};
    await migrate();
    await db.user.create({data:{id:"old-owner",email:"migration-fixture@example.invalid",passwordHash:"preserved-hash"}});
    await db.agent.create({data:{id:"old-agent",userId:"old-owner",name:"Existing connection",urn:"urn:test:agent",publicKey:"fixture"}});
    await db.$executeRawUnsafe('ALTER TABLE "Agent" ADD COLUMN "encryptedPrivateKey" TEXT');
    await db.$executeRawUnsafe('UPDATE "Agent" SET "encryptedPrivateKey" = ?',"preserve-obsolete-key-for-offline-archive");
    await db.$executeRawUnsafe('CREATE TABLE "Contact" ("id" TEXT PRIMARY KEY, "alias" TEXT)');
    await db.$executeRawUnsafe('INSERT INTO "Contact" VALUES (?, ?)',"legacy-contact","private legacy alias");
    await db.$executeRawUnsafe('CREATE UNIQUE INDEX "Agent_urn_key" ON "Agent"("urn")');
    await migrate();await migrate();
    assert.equal((await db.user.findUnique({where:{id:"old-owner"}})).passwordHash,"preserved-hash");
    assert.deepEqual(await db.$queryRawUnsafe('SELECT * FROM "Contact"'),[{id:"legacy-contact",alias:"private legacy alias"}]);
    assert.equal((await db.$queryRawUnsafe('SELECT "encryptedPrivateKey" FROM "Agent"'))[0].encryptedPrivateKey,"preserve-obsolete-key-for-offline-archive");
    await db.controlRequest.create({data:{id:"rpc-test",agentId:"old-agent",consoleUrn:"urn:console:test",method:"capabilities",fingerprint:"hash",requestEnvelope:"encrypted",deadline:new Date(Date.now()+120000),expiresAt:new Date(Date.now()+600000)}});
    assert.equal((await db.controlRequest.findUnique({where:{id:"rpc-test"}})).requestEnvelope,"encrypted");
    await db.user.create({data:{id:"second-owner",email:"other-fixture@example.invalid",passwordHash:"other"}});
    await db.agent.create({data:{id:"second-connection",userId:"second-owner",name:"Authorized elsewhere",urn:"urn:test:agent",publicKey:"fixture"}});
    assert.equal(await db.agent.count({where:{urn:"urn:test:agent"}}),2,"public URNs cannot be squatted by another Web account");
    await assert.rejects(db.agent.create({data:{userId:"old-owner",name:"duplicate",urn:"urn:test:agent",publicKey:"fixture"}}),{code:"P2002"});
  } finally {
    await db.$disconnect();
    for(const suffix of ["","-journal","-wal","-shm"])if(fs.existsSync(filename+suffix))fs.unlinkSync(filename+suffix);
    fs.rmdirSync(directory);
  }
});
