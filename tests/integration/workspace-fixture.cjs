// Manual loopback-only signed Registry/MQ fixture with a fresh SQLite database and random keys.
// Build Next first, then keep this process running for workspace-browser.cjs and workspace-resilience.cjs.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),crypto=require('node:crypto'),Module=require('node:module');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const ts=require('typescript');
const {PrismaClient}=require('@prisma/client');
const bcrypt=require('bcryptjs');
const root=path.resolve(__dirname,'../..'),base='http://127.0.0.1:3062',platform='http://127.0.0.1:3061';
const output=path.join(root,'build/workspace-sync-preview');fs.mkdirSync(output,{recursive:true});
function load(file,deps={}){
 const name=path.join(root,'src/lib',file+'.ts'),m=new Module(name,module);m.filename=name;m.paths=Module._nodeModulePaths(path.dirname(name));
 m.require=n=>Object.hasOwn(deps,n)?deps[n]:Module.prototype.require.call(m,n);
 m._compile(ts.transpileModule(fs.readFileSync(name,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,name);return m.exports;
}
const proto=load('protocol/proto'),keys=load('protocol/crypto'),ecies=load('protocol/ecies'),auth=load('protocol/protocol-auth',{'@/lib/protocol/proto':proto});
const secret='workspace-smoke-only-'+crypto.randomBytes(32).toString('hex');
const dbFile=path.join(output,'fixture-'+Date.now()+'.db'),db=new PrismaClient({datasources:{db:{url:'file:'+dbFile.replaceAll('\\','/')}}});
const identities=new Map(),mailboxes=new Map(),turns=new Map(),calls=[];
let child,server,offline=false,extraMessage=false,stopping=false,log='';
const attentionMode=process.env.ATTENTION_FIXTURE==='1',fixtureAt=Math.floor(Date.now()/1000);
const mutationMode=process.env.MUTATION_FIXTURE==='1',mutationContacts=new Map(),mutationDecisions=new Map(),mutationResults=new Map();
const socialMode=process.env.SOCIAL_FIXTURE==='1', socialStates=new Map();
function socialState(request) {
 const key=request.agent_urn+'|'+request.console_urn;
 if(!socialStates.has(key))socialStates.set(key,{revision:1,contacts:[{contact_id:'friend-online',urn:'urn:fixture:online',aliases:['在线好友'],connection_status:'connected',presence:{status:'online',expires_at:fixtureAt+3600}},{contact_id:'friend-rejected',urn:'urn:fixture:rejected',aliases:['被拒绝的好友'],connection_status:'rejected'},{contact_id:'friend-pending',urn:'urn:fixture:pending',aliases:['等待中的好友'],connection_status:'pending'}],contact_requests:[{request_id:'incoming-accept',direction:'incoming',peer_urn:'urn:fixture:alice',status:'pending',created_at:fixtureAt},{request_id:'incoming-reject',direction:'incoming',peer_urn:'urn:fixture:bob',status:'pending',created_at:fixtureAt},{request_id:'rejected-first',direction:'outgoing',peer_urn:'urn:fixture:rejected',status:'rejected',attempt:1,created_at:fixtureAt},{request_id:'pending-first',direction:'outgoing',peer_urn:'urn:fixture:pending',status:'pending',attempt:1,created_at:fixtureAt}],messages:[{message_id:'social-message',sender_urn:'urn:fixture:online',text:'这条消息需要两端同步已读',read:false,received_at:fixtureAt},{message_id:'social-message-web',sender_urn:'urn:fixture:online',text:'这条消息通过网页标为已读',read:false,received_at:fixtureAt}],sent_messages:[]});
 return socialStates.get(key);
}
let mutationWritesEnabled=true;
const mutationApprovals=[
 {approval_id:'approval-web-approve',subject_id:'允许发送会议提议',question:'请核对：仅向小王发送明天下午 3 点的会议提议。\n不会创建日历，也不代表对方已经同意。',status:'pending',expires_at:fixtureAt+3600},
 {approval_id:'approval-web-deny',subject_id:'拒绝分享资料',question:'是否允许向小李分享本次项目资料？',status:'presenting',expires_at:fixtureAt+3600},
 {approval_id:'approval-web-expired',subject_id:'重新核对过期展示',question:'上次展示已过期。是否仍同意本次有效事项的安排？',status:'expired',expires_at:fixtureAt-60},
 {approval_id:'approval-web-unknown',subject_id:'核实断线后的回应',question:'仅测试本次回应是否已由 agent 保存。',status:'pending',expires_at:fixtureAt+3600},
 {approval_id:'approval-web-fail',subject_id:'事项已撤销',question:'这项事项已被撤销，旧快照仍显示待确认。',status:'pending',expires_at:fixtureAt+3600},
];
let approvalResolved=false;
function identity(){
 const ed=crypto.generateKeyPairSync('ed25519'),x=crypto.generateKeyPairSync('x25519');
 const edRaw=ed.publicKey.export({type:'spki',format:'der'}).subarray(-32),xRaw=x.publicKey.export({type:'spki',format:'der'}).subarray(-32);
 return {ed,x,edRaw,xRaw,xPrivate:x.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32),urn:keys.deriveUrnFromEd25519PubKey(edRaw.toString('hex'))};
}
function json(res,data,status=200){res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));}
async function read(req){let body='';for await(const piece of req)body+=piece;return body?JSON.parse(body):{};}
function verifyBody(req,body){
 const [signature,publicKey]=(req.headers.authorization||'').slice(8).split(':');
 const identity=[...identities.values()].find(i=>i.edRaw.toString('hex')===publicKey);
 assert.ok(identity);assert.equal(crypto.verify(null,Buffer.from(JSON.stringify(body)),identity.ed.publicKey,Buffer.from(signature,'hex')),true);return identity;
}
function resultFor(request){
 if(request.method==='capabilities')return {methods:['capabilities','contacts.list','collaboration.state','inbox.list','conversation.get','conversation.send',...(attentionMode||socialMode?['attention.list']:[]),...(socialMode?['contacts.add','contacts.requests','contacts.respond','messages.send','inbox.mark_read','collaboration.execute']:[]),...(mutationMode?['contacts.add','approval.respond']:[])].map(name=>({name,available:!['contacts.add','approval.respond'].includes(name)||mutationWritesEnabled})),pairing:{expires_at:Date.now()/1000+3600}};
 if(socialMode){
  const state=socialState(request),params=request.params;
  if(request.method==='collaboration.execute')return params.action==='describe'?{actions:['describe','prepare_message'],action_fields:{prepare_message:{required:['recipient_urn','text'],optional:[]}}}:{status:'uncertain',instruction:'本机重启后尚不能确认操作，请查询记录核实。'};
  if(request.method==='collaboration.state')return {...state,inbox:{messages:state.messages},tasks:[],pending_confirmations:[]};
  if(request.method==='contacts.list')return {contacts:state.contacts};
  if(request.method==='contacts.requests')return {contact_requests:state.contact_requests};
  if(request.method==='inbox.list')return {messages:state.messages};
  if(request.method==='contacts.add'){
   const old=state.contacts.find(item=>item.contact_id===params.contact_id),sameUrn=state.contacts.find(item=>item.urn===params.urn);
   if((old&&!(old.urn===params.urn&&JSON.stringify(old.aliases)===JSON.stringify(params.aliases)))||(!old&&sameUrn))return {__error:{code:'invalid_params',message:'This agent identity is already a confirmed contact; use the existing contact'}};
   const contact=old||{...params,connection_status:'pending'};
   if(!old)state.contacts.push(contact);
   if(contact.connection_status==='connected')return {decision:'allow',status:'already_connected',contact};
   const pending=state.contact_requests.find(item=>item.direction==='outgoing'&&item.peer_urn===params.urn&&item.status==='pending');
   if(pending)return {decision:'allow',status:'already_requested',contact,request_id:pending.request_id};
   const attempt=1+state.contact_requests.filter(item=>item.direction==='outgoing'&&item.peer_urn===params.urn).length;
   const request_id='friend-'+params.contact_id+'-'+attempt;
   contact.connection_status='pending';state.contact_requests.push({request_id,peer_urn:params.urn,direction:'outgoing',status:'pending',attempt,created_at:fixtureAt});state.revision++;
   return {decision:'allow',status:'requested',contact,request_id};
  }
  if(request.method==='contacts.respond'){
   const item=state.contact_requests.find(item=>item.request_id===params.request_id);assert.ok(item);
   item.status=params.decision==='accept'?'accepted':'rejected';state.revision++;
   if(item.status==='accepted'&&!state.contacts.some(c=>c.urn===item.peer_urn))state.contacts.push({contact_id:'accepted-'+item.request_id,urn:item.peer_urn,aliases:['已接受好友'],connection_status:'connected',presence:{status:'offline',expires_at:null}});
   return {request_id:item.request_id,status:item.status};
  }
  if(request.method==='messages.send'){state.sent_messages.push({...params,status:'accepted'});return {message_id:params.message_id,status:'accepted'};}
  if(request.method==='inbox.mark_read'){const item=state.messages.find(item=>item.message_id===params.message_id);assert.ok(item);item.read=true;state.revision++;return {message_id:item.message_id,status:'read'};}
  if(request.method==='attention.list'){
   const items=[{attention_id:'inbox:social-message',kind:'peer_message_received',subject_id:'social-message',source_revision:state.revision,revision:state.revision,state:state.messages[0].read?'resolved':'open',title:'收到好友消息',safe_summary:'好友发来消息',target:{kind:'inbox',id:'social-message'},created_at:fixtureAt,updated_at:fixtureAt+state.revision}];
   return {schema:'agent-comm-attention/v1',items:(params.after||0)<state.revision?items:[],cursor:state.revision,has_more:false};
  }
 }
 if(mutationMode){
  const key=request.agent_urn+'|'+request.console_urn;
  const contacts=mutationContacts.get(key)||[],decisions=mutationDecisions.get(key)||[];
  if(request.method==='collaboration.state')return {tasks:[],operations:[],pending_confirmations:mutationApprovals.filter(a=>!decisions.some(d=>d.approval_id===a.approval_id)),approval_decisions:decisions,contacts,inbox:[]};
  if(request.method==='contacts.list')return {contacts};
  if(['contacts.add','approval.respond'].includes(request.method)){
   if(!mutationWritesEnabled)return {__error:{code:'method_not_allowed',message:'Method is not allowed'}};
   const ledger=key+'|'+request.request_id;
   if(mutationResults.has(ledger))return mutationResults.get(ledger);
   let result;
   if(request.method==='contacts.add'){
    const contact={...request.params,confirmed:true};mutationContacts.set(key,[...contacts,contact]);
    result={decision:'allow',status:'confirmed',contact};
   }else{
    if(request.params.approval_id==='approval-web-fail')return {__error:{code:'invalid_params',message:'事项已撤销，请刷新后核实。'}};
    const approval=mutationApprovals.find(a=>a.approval_id===request.params.approval_id);assert.ok(approval);
    const approved=request.params.decision==='approve';
    mutationDecisions.set(key,[...decisions.filter(d=>d.approval_id!==approval.approval_id),{...approval,status:approved?'approved':'denied'}]);
    result={approval_id:approval.approval_id,decision:approved?'allow':'deny',status:approved?'approved_once':'denied'};
   }
   mutationResults.set(ledger,result);return result;
  }
 }
 if(request.method==='attention.list'&&attentionMode){
  const revision=approvalResolved?2:1;
  const item={attention_id:'fixture-attention-1',kind:'owner_decision_required',subject_id:'fixture-approval-1',task_id:'fixture-task-1',source_revision:'question-1',revision,state:approvalResolved?'resolved':'open',title:'确认会议时间',safe_summary:'双方建议明天下午线上讨论。请回到原生渠道决定此次安排。',target:{kind:'approval',id:'fixture-approval-1'},created_at:fixtureAt,updated_at:fixtureAt+(approvalResolved?1:0),expires_at:fixtureAt+3600};
  return {schema:'agent-comm-attention/v1',items:(request.params.after||0)<revision?[item]:[],cursor:revision,has_more:false};
 }
 if(request.method==='collaboration.state'&&attentionMode)return {tasks:[],operations:[],pending_confirmations:approvalResolved?[]:[{approval_id:'fixture-approval-1',subject_id:'fixture-task-1',question:'允许明天下午线上讨论30分钟？',status:'pending',expires_at:fixtureAt+3600}],contacts:[],inbox:[],collaboration:{protocol:'agent-comm-collaboration/v2',collaborations:[{collaboration_id:'fixture-collaboration-1',task_id:'fixture-task-1',peer_urn:'urn:fixture:peer',phase:'partially_accepted',terms:{version:1,topic:'项目方案讨论',start:fixtureAt+86400,end:fixtureAt+88200,participant_ids:['urn:fixture:self','urn:fixture:peer']},acceptances:{'urn:fixture:peer':{active:true,terms_digest:'fixture-terms-digest'}},agreement:null,agreement_synced:false}],invitations:[],calendar_created:false}};
 if(request.method==='collaboration.state')return {tasks:[],operations:[],pending_confirmations:[],proposals:[],contacts:[{urn:'urn:fixture:contact',alias:extraMessage?'更新后的联系人':'自动同步联系人'}],inbox:[{message_id:'fixture-message-1',sender_urn:'urn:fixture:peer',text:'这是一条主动同步的来信',received_at:Date.now()/1000},...(extraMessage?[{message_id:'fixture-message-2',sender_urn:'urn:fixture:peer',text:'关闭页面期间同步的新来信',received_at:Date.now()/1000}]:[])]};
 if(request.method==='conversation.send'){
  const conv=request.params.conversation_id||request.request_id,id='turn-'+crypto.createHash('sha256').update(request.console_urn+'\0'+request.request_id).digest('hex').slice(0,40);
  const key=request.agent_urn+'|'+request.console_urn+'|'+conv;
  if(!(turns.get(key)||[]).some(t=>t.turn_id===id))turns.set(key,[...(turns.get(key)||[]),{turn_id:id,text:request.params.text,response:'这是自动同步回来的回复',status:'completed',error:null,created_at:Date.now()/1000,updated_at:Date.now()/1000}]);
  return {status:'submitted',conversation_id:conv,turn_id:id};
 }
 if(request.method==='conversation.get')return {conversation_id:request.params.conversation_id,turns:turns.get(request.agent_urn+'|'+request.console_urn+'|'+request.params.conversation_id)||[]};
 throw new Error('Unexpected automatic method '+request.method);
}
async function handle(req,res){
 const url=new URL(req.url,platform);
 if(url.pathname==='/fixture/summary')return json(res,{calls:calls.map(c=>({agentId:c.agentId,method:c.method,id:c.id})),offline,extraMessage,...(mutationMode?{mutationContacts:[...mutationContacts.values()].flat(),mutationDecisions:[...mutationDecisions.values()].flat()}: {})});
 if(url.pathname==='/fixture/mode'&&req.method==='POST'){
  const body=await read(req);if(typeof body.offline==='boolean')offline=body.offline;if(typeof body.extraMessage==='boolean')extraMessage=body.extraMessage;
  if(attentionMode&&typeof body.resolveApproval==='boolean')approvalResolved=body.resolveApproval;
  if(mutationMode&&typeof body.writesAllowed==='boolean')mutationWritesEnabled=body.writesAllowed;
  if(socialMode)for(const state of socialStates.values()){
   if(typeof body.externalOutgoing==='boolean'){
    const id='external-second',has=state.contact_requests.some(item=>item.request_id===id);
    if(body.externalOutgoing&&!has){state.contact_requests.push({request_id:id,direction:'outgoing',peer_urn:'urn:fixture:rejected',status:'pending',attempt:2,created_at:fixtureAt+1});state.revision++;}
    if(!body.externalOutgoing&&has){state.contact_requests=state.contact_requests.filter(item=>item.request_id!==id);state.revision++;}
   }
   if(body.acceptOutgoing)for(const request of state.contact_requests.filter(item=>item.direction==='outgoing'&&item.status==='pending')){request.status='accepted';const contact=state.contacts.find(item=>item.urn===request.peer_urn);if(contact)contact.connection_status='connected';state.revision++;}
   if(body.nativeRead){state.messages[0].read=true;state.revision++;}
   if(body.nativeUnread){state.messages[0].read=false;state.revision++;}
  }
  if(body.due)await db.$executeRawUnsafe('UPDATE "WorkspaceState" SET "nextSyncAt"=0, "leaseUntil"=NULL, "leaseToken"=NULL');
  if(body.expireCapabilities)await db.$executeRawUnsafe('UPDATE "WorkspaceSnapshot" SET "savedAt"=0 WHERE "method"=\'capabilities\'');
  return json(res,{ok:true});
 }
 if(url.pathname==='/fixture/restart'&&req.method==='POST'){
  await stopWeb();startWeb();return json(res,{restarted:true});
 }
 if(url.pathname==='/fixture/db')return json(res,{states:await db.$queryRawUnsafe('SELECT "agentId","status","lastSuccessAt","nextSyncAt" FROM "WorkspaceState"'),items:await db.$queryRawUnsafe('SELECT "agentId","kind",COUNT(*) as count FROM "WorkspaceItem" GROUP BY "agentId","kind"').then(rows=>rows.map(r=>({...r,count:Number(r.count)})))});
 if(url.pathname==='/fixture/account-check'){
  const {encode}=require('next-auth/jwt');
  const token=await encode({secret,token:{id:'owner-a',sub:'owner-a',email:'owner-a@workspace.invalid'},maxAge:600});
  const opts={headers:{Cookie:'next-auth.session-token='+token}};
  const response=await fetch(base+'/api/agents/agent-a1/workspace',opts);
  const data=await response.json();
  const other=await fetch(base+'/api/agents/agent-b1/workspace',opts);
  return json(res,{status:response.status,otherAccountStatus:other.status,sync:data.sync,hasContacts:!!data.snapshots?.['contacts.list']?.data.contacts?.length,
   inboxCount:data.snapshots?.['inbox.list']?.data.messages?.length||0,conversationCount:data.conversations?.length||0,
   completedTurns:(data.conversation?.turns||[]).filter(t=>t.status==='completed').length});
 }
 if(offline)return json(res,{error:'fixture offline'},503);
 if(url.pathname==='/api/v1/registry/resolve'){
  const i=identities.get(url.searchParams.get('urn'));assert.ok(i,'known fixture registry identity');
  const record={urn:i.urn,peerId:auth.peerIdFromEd25519PublicKey(i.edRaw),x25519Pubkey:i.xRaw,ed25519Pubkey:i.edRaw,storesUserData:true,timestamp:Math.floor(Date.now()/1000)};
  return json(res,{urn:i.urn,peer_id:record.peerId,x25519_pubkey:i.xRaw.toString('base64'),ed25519_pubkey:i.edRaw.toString('base64'),stores_user_data:true,timestamp:record.timestamp,signature:crypto.sign(null,auth.buildRegistrationSigningBytes(record),i.ed.privateKey).toString('base64')});
 }
 if(url.pathname==='/api/v1/mq/store'){
  const body=await read(req),owner=verifyBody(req,body),agent=identities.get(body.recipient_urn);assert.ok(agent);
  const envelope=proto.decodeEncryptedEnvelope(Buffer.from(body.payload_proto,'base64'));auth.verifyEnvelope(envelope,agent.urn);
  const bytes=ecies.decryptWithSharedSecret(ecies.computeSharedSecret(agent.xPrivate,envelope.senderStaticPubkey),envelope.ephemeralPubkey,envelope.nonce,envelope.ciphertext,envelope.tag);
  const chat=proto.decodeChatMessage(bytes),request=JSON.parse(chat.text);assert.equal(request.console_urn,owner.urn);
  calls.push({agentId:agent.id,method:request.method,id:request.request_id});
  const {params,...fields}=request,result=resultFor(request),response={...fields,type:'response',...(result.__error?{error:result.__error}:{result})};
  const plaintext=proto.encodeChatMessage(JSON.stringify(response),Date.now(),{kind:'control.response',inReplyTo:request.request_id,deadline:request.deadline});
  const encrypted=ecies.encryptWithSharedSecret(ecies.computeSharedSecret(agent.xPrivate,owner.xRaw),plaintext);
  const reply=auth.signEnvelope({senderUrn:agent.urn,recipientUrn:owner.urn,senderStaticPubkey:agent.xRaw,ephemeralPubkey:encrypted.ephemeral,nonce:encrypted.nonce,ciphertext:encrypted.ciphertext,tag:encrypted.tag,messageId:'fixture-reply-'+request.request_id},agent.ed.privateKey);
  const payload=proto.encodeEncryptedEnvelope(reply).toString('base64');
  mailboxes.set(owner.urn,[...(mailboxes.get(owner.urn)||[]),{message_id:reply.messageId,payload_proto:payload}]);
  return json(res,{ok:true,message_id:envelope.messageId});
 }
 if(url.pathname==='/api/v1/mq/retrieve'){
  const owner=identities.get(req.headers['x-urn']);assert.ok(owner);
  const stamp=Buffer.alloc(8);stamp.writeBigInt64BE(BigInt(req.headers['x-timestamp']));
  assert.ok(crypto.verify(null,Buffer.concat([Buffer.from('mq-retrieve|'+owner.urn+'|'),stamp]),owner.ed.publicKey,Buffer.from(req.headers['x-signature'],'hex')));
  return json(res,{messages:(mailboxes.get(owner.urn)||[]).slice(0,100)});
 }
 if(url.pathname==='/api/v1/mq/ack'){
  const body=await read(req),owner=verifyBody(req,body);assert.equal(body.recipient_urn,owner.urn);
  mailboxes.set(owner.urn,(mailboxes.get(owner.urn)||[]).filter(m=>!body.message_ids.includes(m.message_id)));return json(res,{ok:true});
 }
 json(res,{error:'unknown fixture route'},404);
}
function startWeb(){
 child=spawn(process.execPath,[path.join(root,'node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port','3062'],{cwd:root,windowsHide:true,env:{...process.env,NEXTAUTH_SECRET:secret,NEXTAUTH_URL:base,DATABASE_URL:'file:'+dbFile.replaceAll('\\','/'),AGENT_PLATFORM_URL:platform,WORKSPACE_SYNC_DISABLED:'0',NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>{log+=b.toString();});child.stderr.on('data',b=>{log+=b.toString();});
}
async function stopWeb(){if(child&&child.exitCode===null){const current=child;await new Promise(resolve=>{current.once('exit',resolve);current.kill();});}fs.writeFileSync(path.join(output,'server.log'),log);}
async function main(){
 const sql=fs.readFileSync(path.join(root,'prisma/remote-console.sql'),'utf8');
 for(const statement of sql.replace(/^\s*--.*$/gm,'').split(';').filter(v=>v.trim()))await db.$executeRawUnsafe(statement);
 for(const account of ['a','b']){
  const owner=identity();identities.set(owner.urn,owner);
  const ed=keys.encryptPrivateKey(owner.ed.privateKey.export({type:'pkcs8',format:'der'}).toString('hex'),secret),x=keys.encryptPrivateKey(owner.x.privateKey.export({type:'pkcs8',format:'der'}).toString('hex'),secret);
  await db.user.create({data:{id:'owner-'+account,email:'owner-'+account+'@workspace.invalid',passwordHash:await bcrypt.hash('Workspace-smoke-fixture-2026',4),virtualUrn:owner.urn,virtualEd25519PublicKey:owner.edRaw.toString('hex'),virtualX25519PublicKey:owner.xRaw.toString('hex'),virtualEd25519PrivateKey:JSON.stringify(ed),virtualX25519PrivateKey:JSON.stringify(x),virtualKeySalt:ed.salt}});
  for(const index of account==='a'?[1,2]:[1]){
   const agent=identity();agent.id='agent-'+account+index;identities.set(agent.urn,agent);
   await db.agent.create({data:{id:agent.id,userId:'owner-'+account,name:account==='a'?'同步测试 A'+index:'另一个账号',urn:agent.urn,publicKey:agent.edRaw.toString('hex'),platformRegistered:true}});
  }
 }
 server=http.createServer((req,res)=>handle(req,res).catch(error=>{console.error('FIXTURE_REQUEST_FAILED',error.message);json(res,{error:'fixture request failed'},500);}));
 await new Promise(resolve=>server.listen(3061,'127.0.0.1',resolve));startWeb();
 const until=Date.now()+70_000;let count=0;
 while(Date.now()<until){count=Number((await db.$queryRawUnsafe('SELECT COUNT(DISTINCT "agentId") as n FROM "WorkspaceSnapshot" WHERE "method"=\'inbox.list\''))[0].n);if(count===3)break;await new Promise(r=>setTimeout(r,500));}
 assert.equal(count,3,'background worker syncs all three saved connections before any browser/API request');
 assert.equal(calls.some(c=>c.method==='conversation.send'),false);
 const report={pre_click_auto_sync:true,connections:count,accounts:2,methods:[...new Set(calls.map(c=>c.method))],url:base};
 fs.writeFileSync(path.join(output,'backend-smoke.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(output,'server.log'),log);
 console.log('FIXTURE_READY '+JSON.stringify(report));
}
async function stop(){if(stopping)return;stopping=true;await stopWeb();server?.close();await db.$disconnect();process.exit();}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
main().catch(async error=>{process.exitCode=1;console.error(error);fs.writeFileSync(path.join(output,'server.log'),log);await stop();});

