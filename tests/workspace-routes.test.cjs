const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const Module=require('node:module');
const test=require('node:test');
const ts=require('typescript');

function load(relative,deps={}){
  const filename=path.resolve(__dirname,relative),loaded=new Module(filename,module);
  loaded.filename=filename;loaded.paths=Module._nodeModulePaths(path.dirname(filename));
  loaded.require=name=>Object.hasOwn(deps,name)?deps[name]:Module.prototype.require.call(loaded,name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
  return loaded.exports;
}

test('workspace APIs isolate account data, reject foreign origins, and only schedule reads',async()=>{
  const previous=process.env.NEXTAUTH_URL;process.env.NEXTAUTH_URL='https://console.example';
  let session=null,started=0;const events=[];
  const {ControlError}=load('../src/lib/control-transport.ts',{'./crypto':{},'./proto':{},'./protocol-auth':{},'./ecies':{}});
  const protocol=load('../src/lib/control-protocol.ts');
  const http=load('../src/lib/workspace-http.ts',{'next-auth':{getServerSession:async()=>session},'./auth':{authOptions:{}},'./control-transport':{ControlError},'./control-protocol':protocol});
  const state={agent:{id:'own-agent'},activeConversationId:'saved-chat',conversations:[],conversation:null,submission:null};
  const store={
    getWorkspaceOverview:async userId=>{events.push(['overview',userId]);return {connections:[{id:'own-agent'}]};},
    getWorkspaceAgent:async(userId,id,conversation,before)=>{events.push(['read',userId,id,conversation,before]);return userId==='owner'&&id==='own-agent'?state:null;},
    scheduleWorkspaceSync:async(userId,id)=>{if(id&&id!=='own-agent')throw new ControlError('not found',404);events.push(['schedule',userId,id]);},
    selectWorkspaceConversation:async(userId,id,conversation)=>{if(id!=='own-agent')throw new ControlError('not found',404);events.push(['select',userId,id,conversation]);},
    dismissWorkspaceSubmission:async(userId,id,requestId)=>{if(id!=='own-agent')throw new ControlError('not found',404);events.push(['dismiss',userId,id,requestId]);},
  };
  const deps={'@/lib/workspace-http':http,'@/lib/workspace-store':store,'@/lib/workspace-sync':{startWorkspaceSync:()=>{started++;}}};
  const overview=load('../src/app/api/workspace/route.ts',deps);
  const sync=load('../src/app/api/workspace/sync/route.ts',deps);
  const agent=load('../src/app/api/agents/[id]/workspace/route.ts',deps);
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
