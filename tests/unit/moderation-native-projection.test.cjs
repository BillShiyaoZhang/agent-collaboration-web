const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),Module=require('node:module'),os=require('node:os'),path=require('node:path'),test=require('node:test'),ts=require('typescript');
const {PrismaClient}=require('@prisma/client');
const {migrateAccountEmail}=require('../../scripts/migrate-account-email.cjs');
function load(relative,deps={}) {
 const filename=path.resolve(__dirname,relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
 m.require=name=>Object.hasOwn(deps,name)?deps[name]:Module.prototype.require.call(m,name);
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
 return m.exports;
}
const shared=load('../../src/lib/control/workbench-client.ts');
const passwords=load('../../src/lib/auth/password.ts');
const email=load('../../src/lib/auth/account-email.ts',{'@/lib/shared/db':{prisma:{}},'./password':passwords});
const rate=load('../../src/lib/moderation/rate.ts',{'@/lib/auth/account-email':email});
const inbound=load('../../src/lib/moderation/inbound.ts',{'@/lib/control/workbench-client':shared});
const SECRET='synthetic-native-projection-secret';
class ControlError extends Error {constructor(message,status){super(message);this.status=status;}}
async function fixture(run) {
 const previous=process.env.NEXTAUTH_SECRET;process.env.NEXTAUTH_SECRET=SECRET;
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'agent-native-projection-')),filename=path.join(directory,'test.db');
 const db=new PrismaClient({datasources:{db:{url:'file:'+filename+'?connection_limit=1'}}});
 try {
  for(const statement of fs.readFileSync(path.resolve(__dirname,'../../prisma/remote-console.sql'),'utf8').replace(/^\s*--.*$/gm,'').split(';').filter(value=>value.trim()))await db.$executeRawUnsafe(statement);
  await migrateAccountEmail(db);
  const passwordHash=await passwords.hashPassword('synthetic-native-projection-password');
  const user=await db.user.create({data:{id:'owner',email:'owner@example.invalid',passwordHash,virtualUrn:'urn:console:owner'}});
  const other=await db.user.create({data:{id:'other',email:'other@example.invalid',passwordHash,virtualUrn:'urn:console:other'}});
  const agent=await db.agent.create({data:{id:'own-agent',userId:user.id,name:'Owned',urn:'urn:agent:local',publicKey:'synthetic-key'}});
  const second=await db.agent.create({data:{id:'second-agent',userId:user.id,name:'Second',urn:'urn:agent:second',publicKey:'synthetic-key'}});
  const foreign=await db.agent.create({data:{id:'foreign-agent',userId:other.id,name:'Foreign',urn:'urn:agent:foreign',publicKey:'synthetic-key'}});
  const store=load('../../src/lib/workspace/workspace-store.ts',{'@/lib/shared/db':{prisma:db},'@/lib/control/control-transport':{ControlError},'@/lib/control/workbench-client':shared,'@/lib/moderation/inbound':inbound});
  const content=load('../../src/lib/moderation/content-service.ts',{'@/lib/shared/db':{prisma:db},'@/lib/auth/account-email':email,'./rate':rate}).createContentService({db,secret:SECRET});
  const raw={message_id:'native-message',sender_urn:'urn:agent:peer',kind:'chat.message',received_at:1,status:'pending',fingerprint:'a'.repeat(64),text_truncated:false,text:'A complete synthetic peer message requiring an independent owner decision.',unknown:'Unreviewed extension stays private'};
  const save=async body=>store.recordWorkspaceResponse(user,agent,{id:crypto.randomUUID(),agentId:agent.id,method:'inbox.review_preview',createdAt:new Date(),deadline:new Date(Date.now()+120000)},{result:body});
  const rows=()=>db.$queryRawUnsafe('SELECT "id","digest","status","kind","recordId" FROM "ModerationContent" ORDER BY "createdAt","id"');
  await run({db,user,other,agent,second,foreign,store,content,raw,save,rows});
 }finally{
  await db.$disconnect();
  for(const suffix of ['','-journal','-wal','-shm'])if(fs.existsSync(filename+suffix))fs.unlinkSync(filename+suffix);
  fs.rmdirSync(directory);
  if(previous===undefined)delete process.env.NEXTAUTH_SECRET;else process.env.NEXTAUTH_SECRET=previous;
 }
}
async function decide(content,user,item,decision) {
 const preview=await content.action(user.id,{action:'preview',id:item.id});
 return content.action(user.id,{action:'decide',id:item.id,digest:item.digest,decision,previewToken:preview.previewToken,consent:true});
}
async function repeated(state) {
 return fixture(async({db,user,agent,store,content,raw,save,rows})=>{
  await save(raw);
  const item=(await content.list(user.id,agent.id)).items[0];
  assert.equal((await content.action(user.id,{action:'preview',id:item.id})).body.text,raw.text);
  if(state!=='pending')await decide(content,user,item,state==='approved'?'approve':'reject');
  for(let iteration=0;iteration<3;iteration++){
   const workspace=await store.getWorkspaceAgent(user.id,agent.id),projection=workspace.snapshots['inbox.review_preview'].data;
   assert.equal(projection.text,inbound.CONTENT_PENDING);
   assert.equal(projection.content_review.reviewId,item.id);assert.equal(projection.content_review.digest,item.digest);assert.equal(projection.content_review.status,state);
   assert.deepEqual(Object.keys(projection).sort(),['message_id','sender_urn','kind','received_at','status','fingerprint','text','content_review'].sort());
   assert.doesNotMatch(JSON.stringify(projection),/complete synthetic|Unreviewed extension/);
   const again=await inbound.filterWorkspaceInbound(db,user.id,agent.id,agent.urn,'inbox.review_preview',projection);
   assert.equal(again.content_review.reviewId,item.id);assert.equal(again.content_review.status,state);
   const inbox=await inbound.filterWorkspaceInbound(db,user.id,agent.id,agent.urn,'inbox.list',{messages:[again]});
   assert.equal(inbox.messages[0].text,state==='approved'?raw.text:inbound.CONTENT_PENDING);
   await save({...raw,received_at:iteration+2,status:state,read:true,read_at:iteration+3});
   const saved=await rows();assert.equal(saved.length,1);assert.equal(saved[0].id,item.id);assert.equal(saved[0].digest,item.digest);assert.equal(saved[0].status,state);
  }
 });
}
for(const state of ['pending','rejected','approved'])test('saved Native preview keeps its exact '+state+' review through repeated real snapshot/read projections without queuing a placeholder',()=>repeated(state));

test('historical placeholder versions remain independently rejected while the real full version stays pending',()=>fixture(async({db,user,agent,store,content,raw,save,rows})=>{
 // Replay an old unmarked projection through the real filter to retain its
 // actual generated metadata/digest, rather than inventing a historical row.
 const legacy={message_id:raw.message_id,sender_urn:raw.sender_urn,kind:raw.kind,text:inbound.CONTENT_PENDING};
 const older=(await inbound.filterWorkspaceInbound(db,user.id,agent.id,agent.urn,'inbox.review_preview',legacy)).content_review;
 await decide(content,user,{id:older.reviewId,digest:older.digest},'reject');
 await save(raw);
 const full=(await content.list(user.id,agent.id)).items.find(item=>item.id!==older.reviewId);
 assert.equal((await content.action(user.id,{action:'preview',id:full.id})).body.text,raw.text);
 for(let iteration=0;iteration<3;iteration++){
  const view=await store.getWorkspaceAgent(user.id,agent.id);
  assert.equal(view.snapshots['inbox.review_preview'].data.content_review.reviewId,full.id);
  assert.equal(view.snapshots['inbox.review_preview'].data.content_review.status,'pending');
  const saved=await rows();assert.equal(saved.length,2);
  assert.equal(saved.find(row=>row.id===older.reviewId).status,'rejected');assert.equal(saved.find(row=>row.id===full.id).status,'pending');
 }
 await assert.rejects(decide(content,user,{id:older.reviewId,digest:older.digest},'approve'),error=>error.code==='CONTENT_REJECTED');
 const hidden=await inbound.filterWorkspaceInbound(db,user.id,agent.id,agent.urn,'inbox.review_preview',legacy);
 assert.equal(hidden.content_review.reviewId,older.reviewId);assert.equal(hidden.content_review.status,'rejected');assert.equal((await rows()).length,2);
}));

test('a legitimate literal equal to the placeholder is still real peer content requiring exact independent approval',()=>fixture(async({db,user,agent,content,raw,save,rows})=>{
 await save({...raw,text:inbound.CONTENT_PENDING});
 const saved=await rows();assert.equal(saved.length,1);assert.equal(saved[0].status,'pending');
 const item=(await content.list(user.id,agent.id)).items[0],preview=await content.action(user.id,{action:'preview',id:item.id});
 assert.equal(preview.body.text,inbound.CONTENT_PENDING);assert.equal(preview.body.unknown,raw.unknown);
 await decide(content,user,item,'approve');
 assert.equal((await rows())[0].status,'approved');
}));

test('forged references and mismatched user, agent, record or kind never unseal another review subject',()=>fixture(async({db,user,other,agent,second,foreign,content,raw,rows})=>{
 const examples=[];
 for(const [owner,connection,kind,id,label] of [[other,foreign,'inbox',raw.message_id,'foreign-user-secret'],[user,second,'inbox',raw.message_id,'other-agent-secret'],[user,agent,'inbox','another-message','other-record-secret'],[user,agent,'collaboration',raw.message_id,'other-kind-secret']]){
  const reference=await inbound.reviewPeerContent(db,owner.id,connection.id,kind,id,{message_id:id,sender_urn:raw.sender_urn,text:label});
  await decide(content,owner,{id:reference.reviewId,digest:reference.digest},'approve');
  examples.push(reference);
 }
 const own=await inbound.reviewPeerContent(db,user.id,agent.id,'inbox',raw.message_id,{message_id:raw.message_id,sender_urn:raw.sender_urn,text:'known-owned-secret'});
 await decide(content,user,{id:own.reviewId,digest:own.digest},'approve');
 const before=await rows();
 for(const [viewer,connection,reference] of [...examples.map(reference=>[user,agent,reference]),[other,agent,own],[user,second,own],[user,agent,{reviewId:crypto.randomUUID(),digest:'0'.repeat(64)}]]){
  const projection=await inbound.filterWorkspaceInbound(db,viewer.id,connection.id,connection.urn,'inbox.review_preview',{message_id:raw.message_id,sender_urn:raw.sender_urn,text:inbound.CONTENT_PENDING,content_review:{...reference,status:'approved'}});
  assert.equal(projection.text,inbound.CONTENT_PENDING);assert.equal(projection.content_review.status,'pending');
  assert.doesNotMatch(JSON.stringify(projection),/foreign-user-secret|other-agent-secret|other-record-secret|other-kind-secret|known-owned-secret/);
 }
 assert.deepEqual(await rows(),before);
}));
