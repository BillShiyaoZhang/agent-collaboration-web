const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const test=require('node:test');
const ts=require('typescript');

function load(relative,deps={}){
  const filename=path.resolve(__dirname,relative),loaded=new Module(filename,module);
  loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  loaded.require=name=>Object.hasOwn(deps,name)?deps[name]:name==='@/lib/shared/http-input'?load('../../src/lib/shared/http-input.ts'):Module.prototype.require.call(loaded,name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
  return loaded.exports;
}

test('workspace APIs isolate account data, reject foreign origins, and only schedule reads',async()=>{
  const previous=process.env.NEXTAUTH_URL;process.env.NEXTAUTH_URL='https://console.example';
  let session=null,started=0,policyAllowed=false;const events=[];
  class PolicyConsentRequiredError extends Error {}
  const {ControlError}=load('../../src/lib/control/control-transport.ts',{'@/lib/protocol/crypto':{},'@/lib/protocol/proto':{},'@/lib/protocol/protocol-auth':{},'@/lib/protocol/ecies':{},'@/lib/control/v2-policy':{}});
  const protocol=load('../../src/lib/control/control-protocol.ts');
  const http=load('../../src/lib/workspace/workspace-http.ts',{'next-auth':{getServerSession:async()=>session},'@/lib/auth/auth':{authOptions:{}},'@/lib/control/control-transport':{ControlError},'@/lib/control/control-protocol':protocol});
  const state={agent:{id:'own-agent'},activeConversationId:'saved-chat',conversations:[],conversation:null,submission:null};
  const store={
    getWorkspaceOverview:async userId=>{events.push(['overview',userId]);return {connections:[{id:'own-agent'}]};},
    getWorkspaceAgent:async(userId,id,conversation,before)=>{events.push(['read',userId,id,conversation,before]);return userId==='owner'&&id==='own-agent'?state:null;},
    scheduleWorkspaceSync:async(userId,id)=>{if(id&&id!=='own-agent')throw new ControlError('not found',404);events.push(['schedule',userId,id]);},
    selectWorkspaceConversation:async(userId,id,conversation)=>{if(id!=='own-agent')throw new ControlError('not found',404);events.push(['select',userId,id,conversation]);},
    dismissWorkspaceSubmission:async(userId,id,requestId)=>{if(id!=='own-agent')throw new ControlError('not found',404);events.push(['dismiss',userId,id,requestId]);},
  };
  const deps={'@/lib/workspace/workspace-http':http,'@/lib/workspace/workspace-store':store,'@/lib/workspace/workspace-sync':{startWorkspaceSync:()=>{started++;}},
    '@/lib/control/v2-policy':{PolicyConsentRequiredError,requirePolicyAcknowledgement:async()=>{if(!policyAllowed)throw new PolicyConsentRequiredError('policy consent required');}},
    '@/lib/control/control-transport':{ControlError}};
  const overview=load('../../src/app/api/workspace/route.ts',deps);
  const sync=load('../../src/app/api/workspace/sync/route.ts',deps);
  const agent=load('../../src/app/api/agents/[id]/workspace/route.ts',deps);
  const req=(data,origin='https://console.example')=>new Request('https://console.example/api/workspace',{method:'POST',headers:{origin,'Content-Type':'application/json'},body:typeof data==='string'?data:JSON.stringify(data)});
  try{
    assert.equal((await overview.GET()).status,401);
    assert.equal((await sync.POST(req({}))).status,401);
    assert.equal(events.length,0);assert.equal(started,0);
    session={user:{id:'owner'}};
    const cached=await overview.GET();assert.equal(cached.status,200);
    assert.match(cached.headers.get('cache-control'),/private.*no-store/);assert.equal(cached.headers.get('vary'),'Cookie');
    assert.deepEqual(await cached.json(),{connections:[{id:'own-agent'}]});
    assert.equal((await agent.GET(new Request('https://console.example/api/agents/other/workspace'),{params:{id:'other'}})).status,404);
    assert.equal((await sync.POST(req({agentId:'own-agent'},'https://attacker.example'))).status,403);
    assert.equal((await sync.POST(req({userId:'another-account'}))).status,400);
    assert.equal((await sync.POST(req('x'.repeat(4097)))).status,413);
    let pulls=0,cancelled=false;
    const stream=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(2048));},cancel(){cancelled=true;}},{highWaterMark:0});
    assert.equal((await sync.POST(new Request('https://console.example/api/workspace/sync',{method:'POST',headers:{origin:'https://console.example'},body:stream,duplex:'half'}))).status,413);
    assert.equal(pulls,3);assert.equal(cancelled,true);assert.equal(events.some(event=>event[0]==='schedule'),false);
    assert.equal((await sync.POST(req({}))).status,409,'sync scheduling waits for explicit policy consent');
    assert.equal(events.some(event=>event[0]==='schedule'),false);
    policyAllowed=true;
    assert.equal((await sync.POST(req({agentId:'other'}))).status,404);
    assert.equal((await sync.POST(req({}))).status,202);
    assert.deepEqual(events.find(event=>event[0]==='schedule'),['schedule','owner',undefined]);
    assert.equal((await agent.GET(new Request('https://console.example/api/agents/own-agent/workspace?conversation_id=&before=bad%20cursor'),{params:{id:'own-agent'}})).status,400);
    assert.equal((await agent.GET(new Request('https://console.example/api/agents/own-agent/workspace?conversation_id='),{params:{id:'own-agent'}})).status,200);
    assert.deepEqual(events.at(-1),['read','owner','own-agent','',undefined],'empty conversation explicitly preserves a new chat');
    assert.equal((await agent.POST(req({action:'select_conversation',conversationId:null}),{params:{id:'own-agent'}})).status,200);
    assert.ok(events.some(e=>e[0]==='select'&&e[1]==='owner'&&e[3]===null));
    assert.equal((await agent.POST(req({action:'conversation.send',text:'never dispatch me'}),{params:{id:'own-agent'}})).status,400);
    assert.equal((await agent.POST(req({action:'select_conversation',conversationId:null},'https://attacker.example'),{params:{id:'own-agent'}})).status,403);
    assert.equal(events.some(e=>e[0]==='send'),false);
  }finally{if(previous===undefined)delete process.env.NEXTAUTH_URL;else process.env.NEXTAUTH_URL=previous;}
});

test('notification endpoints require account and origin, bind exact read versions, and cannot approve',async()=>{
  const previous=process.env.NEXTAUTH_URL;process.env.NEXTAUTH_URL='https://console.example';
  let session=null;const events=[];
  const {ControlError}=load('../../src/lib/control/control-transport.ts',{'@/lib/protocol/crypto':{},'@/lib/protocol/proto':{},'@/lib/protocol/protocol-auth':{},'@/lib/protocol/ecies':{},'@/lib/control/v2-policy':{}});
  const protocol=load('../../src/lib/control/control-protocol.ts');
  const http=load('../../src/lib/workspace/workspace-http.ts',{'next-auth':{getServerSession:async()=>session},'@/lib/auth/auth':{authOptions:{}},'@/lib/control/control-transport':{ControlError},'@/lib/control/control-protocol':protocol});
  const store={getWorkspaceNotifications:async(...args)=>{events.push(['list',...args]);return {items:[],unread:0,pending:0,before:null,hasMore:false};},readWorkspaceNotification:async(...args)=>events.push(['read',...args]),claimWorkspaceNotification:async(...args)=>{events.push(['claim',...args]);return false;}};
  const route=load('../../src/app/api/notifications/route.ts',{'@/lib/workspace/workspace-http':http,'@/lib/workspace/workspace-store':store,'@/lib/control/control-transport':{ControlError}});
  const body={action:'read',agentId:'own-agent',id:'a'.repeat(64),revision:7};
  const request=(value=body,origin='https://console.example')=>new Request('https://console.example/api/notifications',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(value)});
  try{
    assert.equal((await route.GET(new Request('https://console.example/api/notifications'))).status,401);
    assert.equal((await route.POST(request())).status,401);assert.equal(events.length,0);
    session={user:{id:'owner'}};
    assert.equal((await route.POST(request(body,'https://attacker.invalid'))).status,403);
    assert.equal((await route.POST(request({...body,action:'approve'}))).status,400);
    assert.equal((await route.POST(request({...body,userId:'other'}))).status,400);
    assert.equal((await route.POST(request({...body,revision:1.5}))).status,400);
    assert.equal((await route.GET(new Request('https://console.example/api/notifications?before=-1'))).status,400);
    assert.equal((await route.GET(new Request('https://console.example/api/notifications?filter=pending&before=10'))).status,200);
    assert.deepEqual(events.at(-1),['list','owner',10,'pending']);
    const read=await route.POST(request());assert.equal(read.status,200);assert.match(read.headers.get('cache-control'),/private.*no-store/);assert.deepEqual(events.at(-1),['read','owner','own-agent','a'.repeat(64),7]);
    const claim=await route.POST(request({...body,action:'claim',deviceId:'11111111-1111-4111-8111-111111111111'}));assert.deepEqual(await claim.json(),{claimed:false});
  }finally{if(previous===undefined)delete process.env.NEXTAUTH_URL;else process.env.NEXTAUTH_URL=previous;}
});

test('push subscription, display and test routes derive account from the session and reject arbitrary destinations or actions',async()=>{
  const previous=process.env.NEXTAUTH_URL;process.env.NEXTAUTH_URL='https://console.example';
  let session=null,started=0;const events=[];
  class ControlError extends Error { constructor(message,status){super(message);this.status=status;} }
  const protocol=load('../../src/lib/control/control-protocol.ts');
  const http=load('../../src/lib/workspace/workspace-http.ts',{'next-auth':{getServerSession:async()=>session},'@/lib/auth/auth':{authOptions:{}},'@/lib/control/control-transport':{ControlError},'@/lib/control/control-protocol':protocol});
  const store={};for(const name of ['getPushSettings','queuePushTest','recordPushReceipt','resolvePushDisplay','revokePushSubscription','savePushSubscription','updatePushPresence'])store[name]=async(...args)=>{events.push([name,...args]);return {available:true};};
  const route=load('../../src/app/api/notifications/push/route.ts',{'@/lib/workspace/workspace-http':http,'@/lib/control/control-transport':{ControlError},'@/lib/notifications/push-store':store,'@/lib/notifications/push-policy':load('../../src/lib/notifications/push-policy.ts'),'@/lib/notifications/push-worker':{startPushWorker:()=>started++}});
  const deviceId='11111111-1111-4111-8111-111111111111';
  const request=(body,origin='https://console.example')=>new Request('https://console.example/api/notifications/push',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
  try{
    assert.equal((await route.GET(new Request('https://console.example/api/notifications/push?deviceId='+deviceId))).status,401);
    assert.equal((await route.POST(request({action:'test',deviceId}))).status,401);assert.equal(started,0);
    session={user:{id:'owner'}};
    assert.equal((await route.POST(request({action:'test',deviceId},'https://attacker.invalid'))).status,403);
    assert.equal((await route.POST(request({action:'test',deviceId,userId:'other'}))).status,400);
    assert.equal((await route.POST(request({action:'approve',deviceId}))).status,400);
    assert.equal((await route.POST(request({action:'subscribe',deviceId,subscription:{endpoint:'https://127.0.0.1/admin',keys:{p256dh:'A'.repeat(87),auth:'A'.repeat(22)}}}))).status,400);
    assert.equal((await route.POST(request({action:'test',deviceId}))).status,200);assert.deepEqual(events.at(-1),['queuePushTest','owner',deviceId]);
    const identity={deliveryId:'a'.repeat(32),binding:'b'.repeat(32)};
    assert.equal((await route.POST(request({action:'resolve',...identity}))).status,200);assert.deepEqual(events.at(-1),['resolvePushDisplay','owner',identity.deliveryId,identity.binding]);
    assert.equal((await route.POST(request({action:'receipt',...identity,status:'approved'}))).status,400);
    assert.equal((await route.POST(request({action:'receipt',...identity,status:'displayed'}))).status,200);assert.deepEqual(events.at(-1),['recordPushReceipt','owner',identity.deliveryId,identity.binding,'displayed']);
    const response=await route.GET(new Request('https://console.example/api/notifications/push?deviceId='+deviceId));assert.equal(response.status,200);assert.match(response.headers.get('cache-control'),/private.*no-store/);
  }finally{if(previous===undefined)delete process.env.NEXTAUTH_URL;else process.env.NEXTAUTH_URL=previous;}
});
