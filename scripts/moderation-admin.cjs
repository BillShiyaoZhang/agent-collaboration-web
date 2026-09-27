const crypto=require("node:crypto"),fs=require("node:fs");
const {PrismaClient}=require("@prisma/client");
const {seal,unseal}=require("./moderation-storage.cjs");
function createModerationAdmin({db,secret,adminToken}) {
  function authorize(token) { if(typeof adminToken!=="string" || Buffer.byteLength(adminToken)<32 || typeof token!=="string") throw new Error("Administrative authorization required"); const actual=crypto.createHash("sha256").update(token).digest(), expected=crypto.createHash("sha256").update(adminToken).digest(); if(!crypto.timingSafeEqual(actual,expected)) throw new Error("Administrative authorization required"); }
  function table(queue) { if(!["reports","content"].includes(queue)) throw new Error("Choose reports or content"); return queue==="reports"?"ModerationReport":"ModerationContent"; }
  return {
    async list(token,queue,status="pending",limit=20) { authorize(token); const name=table(queue); if(!["pending","reviewing","resolved","dismissed","approved","rejected"].includes(status) || !Number.isInteger(limit) || limit<1 || limit>50) throw new Error("Invalid queue parameters"); const columns=queue==="reports"?'"id","userId","agentId","targetKind","targetId","reason","status","createdAt","updatedAt"':'"id","userId","agentId","kind","recordId","digest","status","createdAt","updatedAt"'; return db.$queryRawUnsafe(`SELECT ${columns} FROM "${name}" WHERE "status"=? ORDER BY "createdAt" ASC,"id" ASC LIMIT ?`,status,limit); },
    async show(token,queue,userId,id) { authorize(token); const name=table(queue), rows=await db.$queryRawUnsafe(`SELECT * FROM "${name}" WHERE "userId"=? AND "id"=?`,userId,id); if(!rows[0]) throw new Error("Record not found"); const row=rows[0]; return {...row,payload:unseal(secret,row.userId,row.agentId,queue==="reports"?"report":"content",row.id,row.payload)}; },
    async handleReport(token,userId,id,{status,response,decision="none",actor,expectedUpdatedAt}) {
      authorize(token);
      if(!["reviewing","resolved","dismissed"].includes(status) || !["none","hide"].includes(decision) || typeof response!=="string" || Buffer.byteLength(response)>4000 || !/^[A-Za-z0-9._:-]{1,128}$/.test(actor || "") || !Number.isFinite(expectedUpdatedAt) || status!=="reviewing" && !response.trim()) throw new Error("Invalid review decision; final decisions need a public response");
      return db.$transaction(async tx=> {
        const rows=await tx.$queryRawUnsafe('SELECT * FROM "ModerationReport" WHERE "userId"=? AND "id"=?',userId,id),row=rows[0]; if(!row) throw new Error("Record not found");
        const body=unseal(secret,row.userId,row.agentId,"report",row.id,row.payload); body.response=response;
        const changed=await tx.$executeRawUnsafe('UPDATE "ModerationReport" SET "status"=?,"decision"=?,"payload"=?,"reviewedBy"=?,"updatedAt"=? WHERE "userId"=? AND "id"=? AND "updatedAt"=?',status,decision,seal(secret,row.userId,row.agentId,"report",row.id,body),actor,Math.max(Date.now(),row.updatedAt+1),userId,id,expectedUpdatedAt);
        if(changed!==1) throw new Error("Review changed; reload before deciding");
        if(decision==="hide") await tx.$executeRawUnsafe('UPDATE "ModerationContent" SET "status"=\'rejected\',"reviewedBy"=?,"updatedAt"=? WHERE "userId"=? AND "agentId"=? AND "kind"=? AND "recordId"=?',actor,Date.now(),userId,row.agentId,row.targetKind,row.targetId);
        return {id,status,response,decision};
      });
    },
    async rejectContent(token,userId,id,actor,expectedUpdatedAt) { authorize(token); if(!/^[A-Za-z0-9._:-]{1,128}$/.test(actor || "") || !Number.isFinite(expectedUpdatedAt)) throw new Error("Invalid administrative decision"); const count=await db.$executeRawUnsafe('UPDATE "ModerationContent" SET "status"=\'rejected\',"reviewedBy"=?,"updatedAt"=MAX("updatedAt"+1,?) WHERE "userId"=? AND "id"=? AND "updatedAt"=?',actor,Date.now(),userId,id,expectedUpdatedAt); if(count!==1) throw new Error("Record not found or review changed"); return {id,status:"rejected"}; },
  };
}
module.exports={createModerationAdmin};
if(require.main===module) {
  const db=new PrismaClient();
  (async()=> {
    const [command,...rest]=process.argv.slice(2),args={}; for(let index=0;index<rest.length;index+=2) { if(!rest[index]?.startsWith("--") || rest[index+1]===undefined) throw new Error("Use named arguments"); args[rest[index].slice(2)]=rest[index+1]; }
    if(!args["token-file"]) throw new Error("--token-file is required; never pass the token in command arguments");
    const stat=fs.statSync(args["token-file"]); if(!stat.isFile() || (stat.mode & 0o077)!==0) throw new Error("Token file must have no group or other permissions");
    const token=fs.readFileSync(args["token-file"],"utf8").trim(),admin=createModerationAdmin({db,secret:process.env.NEXTAUTH_SECRET,adminToken:process.env.MODERATION_ADMIN_TOKEN});
    let result;
    if(command==="list") result=await admin.list(token,args.queue,args.status || "pending",Number(args.limit || 20));
    else if(command==="show") result=await admin.show(token,args.queue,args.user,args.id);
    else if(command==="report") { if(!args["response-file"]) throw new Error("--response-file is required"); result=await admin.handleReport(token,args.user,args.id,{status:args.status,response:fs.readFileSync(args["response-file"],"utf8").trim(),decision:args.decision || "none",actor:args.actor,expectedUpdatedAt:Number(args.updated)}); }
    else if(command==="reject") result=await admin.rejectContent(token,args.user,args.id,args.actor,Number(args.updated));
    else throw new Error("Commands: list, show, report, reject");
    process.stdout.write(JSON.stringify(result,null,2)+"\n");
  })().catch(error=>{ console.error(error.message);process.exitCode=1; }).finally(()=>db.$disconnect());
}
