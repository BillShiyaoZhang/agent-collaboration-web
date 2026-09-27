const assert=require("node:assert/strict"),fs=require("node:fs"),os=require("node:os"),path=require("node:path"),Module=require("node:module"),test=require("node:test"),crypto=require("node:crypto"),ts=require("typescript");
const {PrismaClient}=require("@prisma/client"),React=require("react"),{renderToStaticMarkup}=require("react-dom/server");
const {migrateAccountEmail}=require("../../scripts/migrate-account-email.cjs"),{createModerationAdmin}=require("../../scripts/moderation-admin.cjs");
function load(relative,deps={}) {const filename=path.resolve(__dirname,relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m.require=name=>Object.hasOwn(deps,name)?deps[name]:Module.prototype.require.call(m,name);m._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,filename);return m.exports;}
const shared=load("../../src/lib/control/workbench-client.ts"),passwords=load("../../src/lib/auth/password.ts"),email=load("../../src/lib/auth/account-email.ts",{"@/lib/shared/db":{prisma:{}} ,"./password":passwords});
const rate=load("../../src/lib/moderation/rate.ts",{"@/lib/auth/account-email":email});
const inbound=load("../../src/lib/moderation/inbound.ts",{"@/lib/control/workbench-client":shared});
class ControlError extends Error {constructor(message,status){super(message);this.status=status;}}
const SECRET="synthetic-moderation-test-secret",ADMIN="synthetic-admin-token-over-thirty-two-bytes";
async function fixture(run) {
 const previous=process.env.NEXTAUTH_SECRET;process.env.NEXTAUTH_SECRET=SECRET;
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"agent-moderation-")),filename=path.join(directory,"test.db"),db=new PrismaClient({datasources:{db:{url:"file:"+filename+"?connection_limit=1"}}});
 try {
  for(const statement of fs.readFileSync(path.resolve(__dirname,"../../prisma/remote-console.sql"),"utf8").replace(/^\s*--.*$/gm,"").split(";").filter(value=>value.trim())) await db.$executeRawUnsafe(statement);
  await migrateAccountEmail(db);
  const password="synthetic-account-password",passwordHash=await passwords.hashPassword(password);
  const user=await db.user.create({data:{id:"owner",email:"owner@example.invalid",passwordHash,virtualUrn:"urn:console:owner"}}),other=await db.user.create({data:{id:"other",email:"other@example.invalid",passwordHash,virtualUrn:"urn:console:other"}});
  const agent=await db.agent.create({data:{id:"own-agent",userId:user.id,name:"Owned",urn:"urn:agent:local",publicKey:"synthetic-key"}}),otherAgent=await db.agent.create({data:{id:"other-agent",userId:other.id,name:"Other",urn:"urn:agent:other",publicKey:"synthetic-key"}});
  const store=load("../../src/lib/workspace/workspace-store.ts",{"@/lib/shared/db":{prisma:db},"@/lib/control/control-transport":{ControlError},"@/lib/control/workbench-client":shared,"@/lib/moderation/inbound":inbound});
  const reports=load("../../src/lib/moderation/report-service.ts",{"@/lib/shared/db":{prisma:db},"@/lib/auth/account-email":email,"@/lib/workspace/workspace-store":store,"./rate":rate}).createReportService({db,secret:SECRET});
  const content=load("../../src/lib/moderation/content-service.ts",{"@/lib/shared/db":{prisma:db},"@/lib/auth/account-email":email,"./rate":rate}).createContentService({db,secret:SECRET});
  const admin=createModerationAdmin({db,secret:SECRET,adminToken:ADMIN});
  const row=method=>({id:crypto.randomUUID(),agentId:agent.id,method,createdAt:new Date(),deadline:new Date(Date.now()+120000)});
  const save=async(method,result)=>store.recordWorkspaceResponse(user,agent,row(method),{result});
  await save("conversation.get",{conversation_id:"private-chat",turns:[{turn_id:"private-turn",text:"my own question",response:"a private assistant answer",status:"completed"}]});
  await run({db,user,other,agent,otherAgent,store,reports,content,admin,row,save,password,directory,filename});
 }finally{await db.$disconnect();for(const suffix of ["","-journal","-wal","-shm"])if(fs.existsSync(filename+suffix))fs.unlinkSync(filename+suffix);fs.rmdirSync(directory);if(previous===undefined)delete process.env.NEXTAUTH_SECRET;else process.env.NEXTAUTH_SECRET=previous;}
}
const previewInput=(agent,kind="turn",id="private-turn")=>({reportId:crypto.randomUUID(),agentId:agent.id,target:{kind,id}});
async function prepared(reports,user,agent,kind,id) {const input=previewInput(agent,kind,id),preview=await reports.preview(user.id,input);return {...input,reason:"harassment",comment:"only this record",evidence:"",previewToken:preview.previewToken,consent:true};}
test("peer text is hidden before projection, exact owner approval restores it, changed text is isolated again",()=>fixture(async({db,user,agent,content,save,store})=>{
 const raw={message_id:"peer-message",sender_urn:"urn:agent:peer",kind:"chat",text:"unmarked objectionable peer text",received_at:1,extra:{summary:"also private peer text"}};
 await save("inbox.list",{messages:[raw]});let view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat");
 assert.equal(view.contentSafety.version,1);assert.equal(view.snapshots["inbox.list"].data.messages[0].content_review.status,"pending");assert.doesNotMatch(JSON.stringify(view),/unmarked objectionable|also private/);
 const queued=(await content.list(user.id,agent.id)).items[0],preview=await content.action(user.id,{action:"preview",id:queued.id});assert.equal(preview.body.text,raw.text);
 await content.action(user.id,{action:"decide",id:queued.id,digest:queued.digest,decision:"approve",consent:true,previewToken:preview.previewToken});
 view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat");assert.equal(view.snapshots["inbox.list"].data.messages[0].text,raw.text);assert.equal(view.snapshots["inbox.list"].data.messages[0].content_review.status,"approved");
 await save("inbox.list",{messages:[{...raw,text:"changed peer text"}]});view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat");assert.doesNotMatch(JSON.stringify(view),/changed peer text/);assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ModerationContent"'))[0].n),2);
 assert.equal(view.snapshots["conversation.get"].data.turns[0].response,"a private assistant answer");
}));
test("authenticated native task rights and worker protocol values survive projection; peer lookalikes and extensions remain hidden",()=>fixture(async({db,user,agent,save,store,content})=>{
 const scope={purpose:"Owner's synthetic goal",topic:"Owner's synthetic topic",capabilities:["propose_meeting","accept_meeting"],recipient_ids:["peer"],participant_ids:["self","peer"],resource_ids:[],window_start:"2026-10-01T00:00:00Z",window_end:"2026-10-02T00:00:00Z",allowed_windows:[{start:"2026-10-01T00:00:00Z",end:"2026-10-02T00:00:00Z",extra:"secret window extension"}],max_duration_minutes:30,max_candidates:1,max_actions:20,expires_at:"2026-10-02T00:00:00Z"};
 const native={task_id:"native-task",owner_session:"hermes-native-profile|remote-console",revision:1,status:"active",used_count:0,scope,source_context:{conversation_id:"private-chat",summary:"secret unknown native extension"},worker:{status:"paused",runs_used:4,sends_used:3,waiting_reason:"collaboration_complete"}};
 const question={approval_id:"native-approval",kind:"task",subject_id:native.task_id,status:"pending",question:"Exact native question with potentially secret peer terms",expires_at:Date.now()/1000+900};
 await save("collaboration.state",{tasks:[native,{...native,task_id:"peer-lookalike",sender_urn:"urn:agent:peer",scope:{...scope,topic:"secret fake peer task"}}],pending_confirmations:[question]});
 let view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat"),state=view.snapshots["collaboration.state"].data,task=state.tasks.find(item=>item.task_id===native.task_id);
 assert.deepEqual(task.scope.capabilities,scope.capabilities);assert.equal(task.scope.purpose,scope.purpose);assert.equal(task.scope.topic,scope.topic);assert.equal(task.scope.allowed_windows[0].start,scope.window_start);assert.equal(task.worker.waiting_reason,"collaboration_complete");assert.equal(task.source_context.conversation_id,"private-chat");
 assert.doesNotMatch(JSON.stringify(view),/secret fake peer|secret unknown native|secret window|potentially secret peer/);assert.equal(state.pending_confirmations[0].content_review.status,"pending");
 const queued=(await content.list(user.id,agent.id)).items.find(item=>item.target.id===question.approval_id),preview=await content.action(user.id,{action:"preview",id:queued.id});assert.equal(preview.body.question,question.question);
 await content.action(user.id,{action:"decide",id:queued.id,digest:queued.digest,decision:"approve",previewToken:preview.previewToken,consent:true});
 view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat");assert.equal(view.snapshots["collaboration.state"].data.pending_confirmations[0].question,question.question);
 const before=Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ModerationContent"'))[0].n);
 await save("collaboration.state",{tasks:[{...native,worker:{...native.worker,runs_used:5}}],pending_confirmations:[question]});view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat");
 assert.deepEqual(view.snapshots["collaboration.state"].data.tasks[0].scope.capabilities,scope.capabilities);assert.equal(view.snapshots["collaboration.state"].data.tasks[0].worker.runs_used,5);assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ModerationContent"'))[0].n),before,"changing local worker counters must not create another text-approval version");
}));
test("describe preserves only known action and argument enums, never arbitrary response text",()=>fixture(async({db,user,agent})=>{
 const described=await inbound.filterWorkspaceInbound(db,user.id,agent.id,agent.urn,"collaboration.execute",{actions:["prepare_task","prepare_collaboration","dispatch","unreviewed-action-text"],business_capabilities:["propose_meeting","accept_meeting","unreviewed-capability-text"],action_fields:{prepare_task:{required:["task_id","scope","unreviewed-field-text"],optional:[]}},source_context_support:{rpc_param:"source_conversation_id",summary:"secret source text"},background_worker:{kind:"finite_deterministic_meeting",native_policy_required:true,max_runs:100,max_sends:32},instruction:"secret description instruction"});
 assert.ok(described.actions.includes("prepare_task")&&described.actions.includes("prepare_collaboration")&&described.actions.includes("dispatch"));assert.ok(described.business_capabilities.includes("accept_meeting"));assert.equal(described.action_fields.prepare_task.required[0],"task_id");assert.equal(described.source_context_support.rpc_param,"source_conversation_id");assert.equal(described.background_worker.kind,"finite_deterministic_meeting");assert.doesNotMatch(JSON.stringify(described),/unreviewed-|secret source|secret description/);
}));
test("a masked exact authorization card cannot be approved or denied until its current full question is reviewed",()=>{
 const workflow=load("../../src/components/workbench/collaboration-workflow-model.ts",{"@agent-comm/client-contract":require("@agent-comm/client-contract")});
 const Button=({children,disabled,type})=>React.createElement("button",{disabled,type},children),Link=({children,href})=>React.createElement("a",{href},children);
 const component=load("../../src/components/workbench/mutation-panels.tsx",{"@/lib/control/workbench-client":shared,"./collaboration-workflow-model":workflow,"@/components/ui/button":{Button},"@/components/ui/input":{},"@/components/local-time":{useHydrated:()=>true,useLocalTime:()=>()=>"synthetic time"},"@/lib/shared/utils":{cn:(...values)=>values.filter(Boolean).join(" ")},"next/link":Link});
 const workbench={agentId:"own-agent",snapshots:{"collaboration.state":{data:{}}},mutations:{approvalActions:[],ready:true},busy:{},canRespondApproval:true,available:()=>true};
 const approval={approval_id:"masked-approval",subject_id:"native-task",kind:"task",status:"pending",question:inbound.CONTENT_PENDING,content_review:{status:"pending",reviewId:"review"}};
 let html=renderToStaticMarkup(React.createElement(component.ApprovalRequests,{approvals:[approval],workbench}));assert.match(html,/查看并核对完整授权问题/);assert.match(html,/messageId=masked-approval/);assert.match(html,/<button disabled="" type="button">同意本次请求/);assert.match(html,/<button disabled="" type="button">拒绝本次请求/);
 html=renderToStaticMarkup(React.createElement(component.ApprovalRequests,{approvals:[{...approval,question:"Full exact approved question",content_review:{status:"approved"}}],workbench}));assert.doesNotMatch(html,/<button disabled="" type="button">同意本次请求/);assert.match(html,/Full exact approved question/);
});
test("reporting verifies actual ownership, binds preview and evidence, defaults hidden evidence to empty, and is idempotent",()=>fixture(async({db,user,other,agent,otherAgent,reports,save})=>{
 await save("inbox.list",{messages:[{message_id:"hidden",sender_urn:"urn:agent:peer",kind:"chat",text:"hidden peer body"}]});
 const hidden=await reports.preview(user.id,previewInput(agent,"inbox","hidden"));assert.equal(hidden.evidence,"");
 await assert.rejects(reports.preview(other.id,previewInput(agent)),error=>error.code==="NOT_FOUND");
 const input=await prepared(reports,user,agent);const reply=await reports.submit(user.id,input);assert.equal(reply.report.id,input.reportId);assert.equal(reply.report.status,"pending");assert.equal(reply.report.response,"");
 assert.deepEqual(await reports.submit(user.id,input),reply);assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ModerationReport"'))[0].n),1);
 await assert.rejects(reports.submit(user.id,{...input,comment:"different content"}),error=>error.code==="REPORT_CONFLICT");
 await assert.rejects(reports.submit(other.id,{...input,agentId:otherAgent.id}),error=>error.code==="INVALID_PREVIEW");
 const another=await prepared(reports,user,agent);await assert.rejects(reports.submit(user.id,{...another,evidence:"entire unrelated chat"}),error=>error.code==="INVALID_PREVIEW");
 await assert.rejects(reports.submit(user.id,{...another,consent:false}));await assert.rejects(reports.get(other.id,input.reportId),error=>error.code==="NOT_FOUND");
 assert.equal((await reports.list(user.id)).reports.length,1);
}));
test("administrative token checks precede database access and public replies are durable without sending mail",()=>fixture(async({db,user,other,agent,reports,admin})=>{
 const guarded=createModerationAdmin({db:new Proxy({}, {get(){throw new Error("database must not be touched");}}),secret:SECRET,adminToken:ADMIN});await assert.rejects(guarded.list("wrong","reports"),/authorization/);
 const input=await prepared(reports,user,agent),reply=await reports.submit(user.id,input),queue=await admin.list(ADMIN,"reports");assert.equal(queue.length,1);assert.equal(queue[0].payload,undefined);
 const detail=await admin.show(ADMIN,"reports",user.id,reply.report.id);assert.equal(detail.payload.comment,"only this record");assert.equal(detail.payload.evidence,"");
 await assert.rejects(admin.handleReport("wrong",user.id,reply.report.id,{status:"resolved",response:"handled",actor:"operator",expectedUpdatedAt:detail.updatedAt}),/authorization/);
 await admin.handleReport(ADMIN,user.id,reply.report.id,{status:"resolved",response:"We reviewed this record and addressed it.",actor:"operator-1",expectedUpdatedAt:detail.updatedAt});
 const visible=(await reports.get(user.id,reply.report.id)).report;assert.equal(visible.status,"resolved");assert.match(visible.response,/reviewed/);assert.equal(visible.reviewedBy,undefined);
 await assert.rejects(reports.get(other.id,reply.report.id));assert.equal(await db.authEmailSend.count(),0);
}));
test("report rate limits are persisted, while identical reports remain retryable without a new queue entry",()=>fixture(async({db,user,agent,reports})=>{
 let last;for(let index=0;index<20;index++){last=await prepared(reports,user,agent);await reports.submit(user.id,last);}
 const blocked=await prepared(reports,user,agent);await assert.rejects(reports.submit(user.id,blocked),error=>error.code==="REPORT_RATE_LIMIT");await reports.submit(user.id,last);
 assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ModerationReport"'))[0].n),20);
 const repeat=previewInput(agent);for(let index=21;index<60;index++)await reports.preview(user.id,repeat);await assert.rejects(reports.preview(user.id,repeat),error=>error.code==="MODERATION_RATE_LIMIT");
}));
test("ownership and operator rejection prevent approval, and a reviewed new version requires a new preview",()=>fixture(async({db,user,other,agent,content,admin,save})=>{
 await save("inbox.list",{messages:[{message_id:"protected",sender_urn:"urn:agent:peer",kind:"chat",text:"peer content"}]});const item=(await content.list(user.id)).items[0];
 await assert.rejects(content.action(other.id,{action:"preview",id:item.id}),error=>error.code==="NOT_FOUND");
 const preview=await content.action(user.id,{action:"preview",id:item.id});await assert.rejects(content.action(user.id,{action:"decide",id:item.id,digest:"0".repeat(64),decision:"approve",previewToken:preview.previewToken,consent:true}),error=>error.code==="CONTENT_CHANGED");
 const detail=await admin.show(ADMIN,"content",user.id,item.id);await admin.rejectContent(ADMIN,user.id,item.id,"operator",detail.updatedAt);
 await assert.rejects(content.action(user.id,{action:"decide",id:item.id,digest:item.digest,decision:"approve",previewToken:preview.previewToken,consent:true}),error=>error.code==="CONTENT_REJECTED");
 assert.equal((await content.list(user.id)).items[0].status,"rejected");assert.deepEqual(await db.$queryRawUnsafe("PRAGMA foreign_key_check"),[]);
}));
test("durable safety revisions ignore an old ACL snapshot and a replayed old block receipt after unblock",()=>fixture(async({db,user,agent,store,row,save})=>{
 await save("contacts.list",{contacts:[{contact_id:"peer",urn:"urn:agent:peer",aliases:["Private alias"],blocked:false,connection_status:"connected"}],blocked_peers:[],safety_revision:0});
 async function receipt(method,revision,blocked) {const request=row(method),call={request_id:request.id,method,params:{urn:"urn:agent:peer"}};await store.reserveWorkspaceOperation(user.id,agent.id,call);const response={result:{urn:"urn:agent:peer",status:blocked?"blocked":"unblocked",blocked,connection_status:blocked?"blocked":"connected",safety_revision:revision}};await store.recordWorkspaceResponse(user,agent,request,response);return {request,response};}
 const old=await receipt("contacts.block",1,true);await receipt("contacts.unblock",2,false);
 await save("contacts.list",{contacts:[{contact_id:"peer",urn:"urn:agent:peer",blocked:true,connection_status:"blocked"}],blocked_peers:[{urn:"urn:agent:peer",blocked:true}],safety_revision:1});await store.recordWorkspaceResponse(user,agent,old.request,old.response);
 const view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat");assert.equal(view.snapshots["contacts.list"].data.contacts[0].blocked,false);assert.equal(view.snapshots["contacts.list"].data.blocked_peers.length,0);assert.equal(view.snapshots["contacts.list"].data.safety_revision,2);
 assert.equal((await db.$queryRawUnsafe('SELECT "blocked","revision" FROM "WorkspacePeerSafety"'))[0].blocked,0);
}));
test("new conversations fail closed without the authenticated safe-runtime declaration; safety actions are still available",()=>fixture(async({db,user,agent,store,save})=>{
 await save("capabilities",{methods:[{name:"conversation.send",available:true}]});const call={request_id:crypto.randomUUID(),method:"conversation.send",params:{text:"new private prompt"}};
 await assert.rejects(store.reserveWorkspaceSubmission(user,agent,call),error=>error.status===409);assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceSubmission"'))[0].n),0);
 await save("capabilities",{methods:[{name:"conversation.send",available:true}],peer_content_safety:{version:1,mode:"owner_review",automatic_peer_model_execution:false}});await store.reserveWorkspaceSubmission(user,agent,call);assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspaceSubmission"'))[0].n),1);
}));
test("account deletion explicitly cleans reports, review queues, rate counters and safety decisions without touching another account",()=>fixture(async({db,user,other,agent,otherAgent,reports,save,password})=>{
 await save("inbox.list",{messages:[{message_id:"to-delete",sender_urn:"urn:agent:peer",kind:"chat",text:"private peer body"}]});await reports.submit(user.id,await prepared(reports,user,agent));
 await db.$executeRawUnsafe('INSERT INTO "WorkspacePeerSafety" VALUES (?,?,1,?,1)',agent.id,"urn:agent:peer",Date.now());await db.$executeRawUnsafe('INSERT INTO "ModerationRate" VALUES (?,\'other\',0,1)',other.id);
 const deletion=load("../../src/lib/auth/account-deletion.ts",{"@/lib/shared/db":{prisma:db},"./password":passwords,"./account-email":email}).createAccountDeletionService({db});await deletion.deleteAccount(user.id,password,0);
 for(const table of ["ModerationReport","ModerationContent","ModerationRate"])assert.equal(Number((await db.$queryRawUnsafe(`SELECT COUNT(*) AS n FROM "${table}" WHERE "userId"=?`,user.id))[0].n),0);
 assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspacePeerSafety"'))[0].n),0);assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ModerationRate" WHERE "userId"=?',other.id))[0].n),1);assert.ok(await db.agent.findUnique({where:{id:otherAgent.id}}));
}));
test("the actual deletion component renders with React without a SessionProvider and keeps destructive submission initially disabled",()=>{
 const primitive=({children,...props})=>React.createElement("div",null,children),Button=({children,disabled,type})=>React.createElement("button",{disabled,type},children);
 const {AccountDeletionSection}=load("../../src/components/account-deletion-section.tsx",{"@/components/auth-shell":{AuthNotice:primitive,PasswordInput:props=>React.createElement("input",props)},"@/components/workspace-provider":{useWorkspace:()=>({connections:[]})},"@/components/ui/button":{Button},"@/components/ui/input":{Input:props=>React.createElement("input",props)},"@/components/ui/label":{Label:props=>React.createElement("label",props)},"@/components/ui/dialog":{Dialog:()=>null,DialogContent:primitive,DialogDescription:primitive,DialogFooter:primitive,DialogTitle:primitive},"@/lib/auth/account-deletion-client":{},"@/lib/notifications/browser-push":{},"next/link":primitive});
 const html=renderToStaticMarkup(React.createElement(AccountDeletionSection,{accountId:"owner",email:"owner@example.invalid",onDeleted(){}}));assert.match(html,/删除账户/);assert.match(html,/<button disabled="" type="submit">删除账户<\/button>/);
});
test("a committed report is returned with its original ID even after its preview expires; uncommitted expired previews cannot create reports",()=>fixture(async({db,user,agent,store})=>{
 let clock=Date.now();const reports=load("../../src/lib/moderation/report-service.ts",{"@/lib/shared/db":{prisma:db},"@/lib/auth/account-email":email,"@/lib/workspace/workspace-store":store,"./rate":rate}).createReportService({db,secret:SECRET,now:()=>clock});
 const saved=await prepared(reports,user,agent),expired=await prepared(reports,user,agent),original=await reports.submit(user.id,saved);clock+=900001;
 assert.deepEqual(await reports.submit(user.id,saved),original);
 await assert.rejects(reports.submit(user.id,expired),error=>error.code==="INVALID_PREVIEW");
 assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ModerationReport"'))[0].n),1);
}));
test("peer collaboration extensions, prior snapshots, notifications, protocol packets and operator removals cannot bypass the display gate",()=>fixture(async({db,user,agent,save,store,content,admin,reports})=>{
 const peer={collaboration_id:"peer-collab",peer_urn:"urn:agent:peer",initiator_urn:"urn:agent:peer",phase:"closed",terms:{topic:"secret peer topic"},source_context:{summary:"secret nested source"}};
 await save("collaboration.state",{collaboration:{collaborations:[peer],source_context:{summary:"secret container extension"},invitations:[{message_id:"invite",collaboration_id:"invite-collab",sender_urn:"urn:agent:peer",topic:"secret invitation"}]},tasks:[{task_id:"peer-task",scope:{topic:"secret task"},source_context:{text:"secret task source"}}]});
 let view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat");assert.doesNotMatch(JSON.stringify(view),/secret peer|secret nested|secret container|secret invitation|secret task/);
 assert.equal((await reports.preview(user.id,previewInput(agent,"collaboration","peer-collab"))).evidence,"");
 const invitation=(await content.list(user.id)).items.find(item=>item.target.id==="invite-collab"),shown=await content.action(user.id,{action:"preview",id:invitation.id});await content.action(user.id,{action:"decide",id:invitation.id,digest:invitation.digest,decision:"approve",previewToken:shown.previewToken,consent:true});
 view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat");assert.match(JSON.stringify(view),/secret invitation/);assert.doesNotMatch(JSON.stringify(view),/secret nested|secret container/);
 const count=Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ModerationContent"'))[0].n);await store.getWorkspaceAgent(user.id,agent.id,"private-chat");assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ModerationContent"'))[0].n),count,"reading the same placeholder must not create a different evidence version");
 const report=await reports.submit(user.id,await prepared(reports,user,agent,"collaboration","peer-collab")),detail=await admin.show(ADMIN,"reports",user.id,report.report.id);await admin.handleReport(ADMIN,user.id,report.report.id,{status:"resolved",response:"Removed the reported peer content.",decision:"hide",actor:"operator",expectedUpdatedAt:detail.updatedAt});
 view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat");assert.doesNotMatch(JSON.stringify(view),/secret peer/);
 await save("inbox.list",{messages:[{message_id:"protocol",sender_urn:"urn:agent:peer",kind:"collaboration.v2",text:JSON.stringify({kind:"sync",payload:{topic:"untrusted protocol body"}})}]});view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat");assert.doesNotMatch(JSON.stringify(view),/untrusted protocol body/);assert.equal(view.snapshots["inbox.list"].data.messages[0].content_review.metadata_only,true);
 const direct=await inbound.filterWorkspaceInbound(db,user.id,agent.id,agent.urn,"collaboration.execute",{status:"completed",source_context:{summary:"unreviewed direct receipt"}});assert.doesNotMatch(JSON.stringify(direct),/unreviewed direct receipt/);
}));
test("real report HTTP routes reject cross-origin, missing sessions, oversized and invalid input before persisting anything",()=>fixture(async({db,user,agent,reports})=>{
 const previous=process.env.NEXTAUTH_URL;process.env.NEXTAUTH_URL="https://console.example.invalid";let session={user:{id:user.id}};
 const helper=load("../../src/lib/auth/account-email-http.ts",{"./password":passwords,"./account-email":email,"@/lib/shared/http-input":load("../../src/lib/shared/http-input.ts"),"./auth":{authOptions:{}},"next-auth":{getServerSession:async()=>session}});
 const module=load("../../src/lib/moderation/report-service.ts",{"@/lib/shared/db":{prisma:db},"@/lib/auth/account-email":email,"@/lib/workspace/workspace-store":{},"./rate":rate});
 const route=load("../../src/app/api/moderation/reports/route.ts",{"@/lib/auth/account-email-http":helper,"@/lib/moderation/report-service":{...module,reportService:reports},"@/lib/workspace/workspace-http":{}}),preparedInput=await prepared(reports,user,agent);
 const request=(body,origin=process.env.NEXTAUTH_URL)=>new Request(process.env.NEXTAUTH_URL+"/api/moderation/reports",{method:"POST",headers:{origin},body:typeof body==="string"?body:JSON.stringify(body)});
 try {
  assert.equal((await route.POST(request(preparedInput,"https://untrusted.example.invalid"))).status,403);session=null;assert.equal((await route.POST(request(preparedInput))).status,401);session={user:{id:user.id}};
  assert.equal((await route.POST(request("a".repeat(16385)))).status,413);assert.equal((await route.POST(request({...preparedInput,consent:false}))).status,400);assert.equal((await route.POST(request({...preparedInput,extra:true}))).status,400);
  assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "ModerationReport"'))[0].n),0);
  const accepted=await route.POST(request(preparedInput));assert.equal(accepted.status,200);assert.equal((await accepted.json()).report.id,preparedInput.reportId);assert.match(accepted.headers.get("cache-control"),/private, no-store/);
 }finally{if(previous===undefined)delete process.env.NEXTAUTH_URL;else process.env.NEXTAUTH_URL=previous;}
}));
test("the operator CLI reads a protected token file, rejects unauthorized access and lists metadata without sending messages",()=>fixture(async({user,agent,reports,directory,filename})=>{
 const {spawnSync}=require("node:child_process"),input=await prepared(reports,user,agent);await reports.submit(user.id,input);
 const tokenFile=path.join(directory,"admin.token");fs.writeFileSync(tokenFile,ADMIN,{mode:0o600});
 const invoke=()=>spawnSync(process.execPath,[path.resolve(__dirname,"../../scripts/moderation-admin.cjs"),"list","--queue","reports","--token-file",tokenFile],{encoding:"utf8",env:{...process.env,DATABASE_URL:"file:"+filename,NEXTAUTH_SECRET:SECRET,MODERATION_ADMIN_TOKEN:ADMIN}});
 try{const allowed=invoke();assert.equal(allowed.status,0,allowed.stderr);const records=JSON.parse(allowed.stdout);assert.equal(records[0].id,input.reportId);assert.doesNotMatch(allowed.stdout,/only this record|synthetic-admin|payload/);fs.writeFileSync(tokenFile,"wrong");const denied=invoke();assert.equal(denied.status,1);assert.match(denied.stderr,/authorization/);assert.equal(denied.stdout,"");fs.chmodSync(tokenFile,0o644);assert.match(invoke().stderr,/permissions/);}finally{fs.unlinkSync(tokenFile);}
}));
test("an explicit report removal hides only the reported private reply across current views, direct reads, older turns, previews and search",()=>fixture(async({db,user,agent,reports,admin,store,save})=>{
 const response="removed-only-private-answer";await save("conversation.get",{conversation_id:"private-chat",title:response,turns:[{turn_id:"private-turn",text:"my own prompt",response,status:"completed"},{turn_id:"unreported",text:"another prompt",response:"ordinary private response",status:"completed"}]});
 const input=await prepared(reports,user,agent),report=await reports.submit(user.id,input),row=await admin.show(ADMIN,"reports",user.id,report.report.id);await admin.handleReport(ADMIN,user.id,report.report.id,{status:"resolved",response:"This response was removed.",decision:"hide",actor:"operator",expectedUpdatedAt:row.updatedAt});
 const view=await store.getWorkspaceAgent(user.id,agent.id,"private-chat");assert.doesNotMatch(JSON.stringify(view),new RegExp(response));assert.match(JSON.stringify(view),/ordinary private response/);const tombstone=view.conversation.turns.find(turn=>turn.turn_id==="private-turn");assert.equal(tombstone.text,"my own prompt");assert.equal(tombstone.response,"此回复已根据举报处理决定移除。");assert.equal(tombstone.status,"completed");assert.equal(tombstone.content_review.status,"rejected");assert.equal(tombstone.moderation.status,"rejected");
 assert.equal((await reports.preview(user.id,previewInput(agent))).evidence,"");assert.equal((await store.listWorkspaceConversations(user.id,agent.id,{q:response})).items.length,0);
 const direct=await inbound.filterWorkspaceInbound(db,user.id,agent.id,agent.urn,"conversation.get",{turns:[{turn_id:"private-turn",text:"my prompt",response,source_context:{excerpt:response}}]});assert.doesNotMatch(JSON.stringify(direct),new RegExp(response));
 const laterPage=await inbound.filterWorkspaceInbound(db,user.id,agent.id,agent.urn,"conversation.get",{conversation_id:"private-chat",title:response,source_context:{summary:response},turns:[{turn_id:"unreported",response:"ordinary private response"}]});assert.doesNotMatch(JSON.stringify(laterPage),new RegExp(response));assert.match(JSON.stringify(laterPage),/ordinary private response/);
}));
test("incomplete safety receipts cannot settle an operation or persist a block state",()=>fixture(async({db,user,agent,store,row})=>{
 for(const [method,result] of [["contacts.block",{urn:"urn:agent:peer",blocked:true,status:"blocked",safety_revision:1}],["contacts.unblock",{urn:"urn:agent:peer",blocked:false,status:"unblocked",connection_status:"blocked",safety_revision:2}],["inbox.review",{message_id:"review",status:"approved"}]]){
  const request=row(method),params=method==="inbox.review"?{message_id:"review",decision:"approve"}:{urn:"urn:agent:peer"};await store.reserveWorkspaceOperation(user.id,agent.id,{request_id:request.id,method,params});await store.recordWorkspaceResponse(user,agent,request,{result});
  const operation=(await store.getWorkspaceOperations(user.id,agent.id)).find(value=>value.call.request_id===request.id);assert.equal(operation.phase,"uncertain");
 }
 assert.equal(Number((await db.$queryRawUnsafe('SELECT COUNT(*) AS n FROM "WorkspacePeerSafety"'))[0].n),0);
}));
