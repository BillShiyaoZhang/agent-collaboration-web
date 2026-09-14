const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");

function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
  return loaded.exports;
}
const protocol = load("../src/lib/control-protocol.ts");
const proto = load("../src/lib/proto.ts");
const auth = load("../src/lib/protocol-auth.ts",{"./proto":proto});
const keys = load("../src/lib/crypto.ts");
const ecies = load("../src/lib/ecies.ts");
const transport = load("../src/lib/control-transport.ts",{"./proto":proto,"./protocol-auth":auth,"./crypto":keys,"./ecies":ecies});
const request = () => ({protocol:protocol.CONTROL_PROTOCOL,type:"request",request_id:crypto.randomUUID(),method:"capabilities",params:{},agent_urn:"urn:agent:one",console_urn:"urn:console:one",deadline:new Date(Date.now()+120000).toISOString()});
const response = r => {const {params,...rest}=r;return {...rest,type:"response",result:{methods:[]}};};

test("control request and response bind every authority and correlation field",()=>{
  const r=request(); assert.equal(protocol.controlCallSchema.safeParse({request_id:r.request_id,method:"approval.resolve",params:{approved:true}}).success,false);
  assert.equal(protocol.controlCallSchema.safeParse({request_id:r.request_id,method:r.method,params:{},agent_urn:"injected"}).success,false);
  assert.equal(protocol.controlCallSchema.safeParse({request_id:"bad",method:r.method,params:{}}).success,false);
  const expected={...r};delete expected.params;delete expected.type;delete expected.protocol;
  assert.deepEqual(protocol.validateControlResponse(response(r),expected),response(r));
  for(const field of ["request_id","agent_urn","console_urn","deadline","method","protocol","type"])
    assert.throws(()=>protocol.validateControlResponse({...response(r),[field]:"wrong"},expected));
  for(const data of [{...response(r),params:{}},{...response(r),error:{code:"bad",message:"bad"}},{...response(r),result:undefined,error:true}]) assert.throws(()=>protocol.validateControlResponse(data,expected));
  const {result,...failure}=response(r);
  assert.deepEqual(protocol.validateControlResponse({...failure,error:{code:"unsupported",message:"No handler"}},expected).error,{code:"unsupported",message:"No handler"});
});

test("mutating control routes require the exact configured browser origin",()=>{
  const original=process.env.NEXTAUTH_URL;process.env.NEXTAUTH_URL="https://console.example";
  try {
    protocol.requireSameOrigin(new Request("http://internal/api",{headers:{origin:"https://console.example"}}));
    for(const origin of [undefined,"https://attacker.example","null"]) assert.throws(()=>protocol.requireSameOrigin(new Request("http://internal/api",{headers:origin?{origin}:{}})));
  } finally {if(original===undefined)delete process.env.NEXTAUTH_URL;else process.env.NEXTAUTH_URL=original;}
});

test("the actual RPC route enforces session, saved connection and origin before dispatch",async()=>{
  const original=process.env.NEXTAUTH_URL;process.env.NEXTAUTH_URL="https://console.example";
  let session=null,called=0;
  const user={id:"owner"},agent={id:"my-agent",userId:"owner",urn:"urn:my:agent"};
  const route=load("../src/app/api/agents/[id]/control/route.ts",{
    "next-auth":{getServerSession:async()=>session},"@/lib/auth":{authOptions:{}},
    "@/lib/db":{prisma:{agent:{findFirst:async({where})=>where.id===agent.id&&where.userId===agent.userId?agent:null},user:{findUnique:async()=>user}}},
    "@/lib/control-protocol":protocol,"@/lib/control-transport":transport,
    "@/lib/control-service":{createControlCall:async(_user,target,call)=>{called++;assert.equal(target.urn,agent.urn);return {request_id:call.request_id,status:"pending"};}},
  });
  const body={request_id:crypto.randomUUID(),method:"capabilities",params:{}};
  const req=(data=body,origin="https://console.example")=>new Request("https://console.example/api/agents/my-agent/control",{method:"POST",headers:{origin,"Content-Type":"application/json"},body:JSON.stringify(data)});
  try {
    assert.equal((await route.POST(req(),{params:{id:agent.id}})).status,401);
    session={user:{id:"owner"}};
    assert.equal((await route.POST(req(),{params:{id:"someone-else"}})).status,404);
    assert.equal((await route.POST(req(body,"https://attacker.example"),{params:{id:agent.id}})).status,403);
    assert.equal((await route.POST(req({...body,agent_urn:"injected"}),{params:{id:agent.id}})).status,400);
    assert.equal(called,0);
    assert.equal((await route.POST(req(),{params:{id:agent.id}})).status,202);assert.equal(called,1);
  } finally {if(original===undefined)delete process.env.NEXTAUTH_URL;else process.env.NEXTAUTH_URL=original;}
});

function identity() {
  const ed=crypto.generateKeyPairSync("ed25519"),x=crypto.generateKeyPairSync("x25519");
  const edRaw=ed.publicKey.export({type:"spki",format:"der"}).subarray(-32),xRaw=x.publicKey.export({type:"spki",format:"der"}).subarray(-32);
  return {ed,x,edRaw,xRaw,urn:keys.deriveUrnFromEd25519PubKey(edRaw.toString("hex")),xPrivate:x.privateKey.export({type:"pkcs8",format:"der"}).subarray(-32)};
}
function userFor(identity) {
  return {id:"owner",virtualUrn:identity.urn,virtualEd25519PublicKey:identity.edRaw.toString("hex"),virtualX25519PublicKey:identity.xRaw.toString("hex"),
    virtualEd25519PrivateKey:JSON.stringify(keys.encryptPrivateKey(identity.ed.privateKey.export({type:"pkcs8",format:"der"}).toString("hex"),process.env.NEXTAUTH_SECRET)),
    virtualX25519PrivateKey:JSON.stringify(keys.encryptPrivateKey(identity.x.privateKey.export({type:"pkcs8",format:"der"}).toString("hex"),process.env.NEXTAUTH_SECRET))};
}

test("actual signed/encrypted control transport interoperates and rejects forged responses",async()=>{
  const originalSecret=process.env.NEXTAUTH_SECRET,originalFetch=global.fetch;
  process.env.NEXTAUTH_SECRET="isolated-control-transport-test-secret";
  try {
    const owner=identity(),agent=identity(),user=userFor(owner);
    const record={urn:agent.urn,peerId:auth.peerIdFromEd25519PublicKey(agent.edRaw),x25519Pubkey:agent.xRaw,ed25519Pubkey:agent.edRaw,storesUserData:true,timestamp:Math.floor(Date.now()/1000)};
    record.signature=crypto.sign(null,auth.buildRegistrationSigningBytes(record),agent.ed.privateKey);
    global.fetch=async()=>Response.json({urn:record.urn,peer_id:record.peerId,x25519_pubkey:agent.xRaw.toString("base64"),ed25519_pubkey:agent.edRaw.toString("base64"),stores_user_data:true,timestamp:record.timestamp,signature:record.signature.toString("base64")});
    const r={...request(),agent_urn:agent.urn,console_urn:owner.urn};
    const wire=await transport.encodeControl(user,r),envelope=proto.decodeEncryptedEnvelope(Buffer.from(wire,"base64"));
    auth.verifyEnvelope(envelope,agent.urn);assert.equal(envelope.messageId,r.request_id);
    const plaintext=ecies.decryptWithSharedSecret(ecies.computeSharedSecret(agent.xPrivate,envelope.senderStaticPubkey),envelope.ephemeralPubkey,envelope.nonce,envelope.ciphertext,envelope.tag);
    const chat=proto.decodeChatMessage(plaintext);assert.equal(chat.kind,"control.request");assert.deepEqual(JSON.parse(chat.text),r);
    const body=proto.encodeChatMessage(JSON.stringify(response(r)),Date.now(),{kind:"control.response",inReplyTo:r.request_id,deadline:r.deadline});
    const encryption=ecies.encryptWithSharedSecret(ecies.computeSharedSecret(agent.xPrivate,owner.xRaw),body);
    const reply=auth.signEnvelope({senderUrn:agent.urn,recipientUrn:owner.urn,senderStaticPubkey:agent.xRaw,ephemeralPubkey:encryption.ephemeral,nonce:encryption.nonce,ciphertext:encryption.ciphertext,tag:encryption.tag,messageId:"response-id"},agent.ed.privateKey);
    const encoded=proto.encodeEncryptedEnvelope(reply).toString("base64");
    assert.deepEqual(transport.decodeControl(user,encoded).response,response(r));
    reply.ciphertext[0]^=1;assert.throws(()=>transport.decodeControl(user,proto.encodeEncryptedEnvelope(reply).toString("base64")));
    global.fetch=async(url,init)=>{
      assert.ok(url.endsWith("/api/v1/registry/register"));
      const [signature,publicKey]=init.headers.Authorization.slice("Ed25519 ".length).split(":");
      assert.equal(publicKey,owner.edRaw.toString("hex"));
      assert.equal(crypto.verify(null,Buffer.from(init.body),owner.ed.publicKey,Buffer.from(signature,"hex")),true);
      return Response.json({ok:true});
    };
    await transport.registerConsole(user);
    delete process.env.NEXTAUTH_SECRET;assert.throws(()=>transport.consoleKeys(user),/NEXTAUTH_SECRET/);
  } finally {global.fetch=originalFetch;if(originalSecret===undefined)delete process.env.NEXTAUTH_SECRET;else process.env.NEXTAUTH_SECRET=originalSecret;}
});

function serviceFixture() {
  const rows=new Map(),sent=[],acked=[];let mailbox=[],failSend=false,failWrite=false;
  const user={id:"owner",virtualUrn:"console"},agent={id:"agent",urn:"agent-urn",userId:user.id};
  const prisma={controlRequest:{
    deleteMany:async({where})=>{for(const [id,row] of rows)if(row.expiresAt<=where.expiresAt.lte)rows.delete(id);},
    count:async()=>rows.size,findUnique:async({where})=>rows.get(where.id)||null,
    findFirst:async({where})=>{const row=rows.get(where.id);return row&&where.agent.userId===user.id&&row.consoleUrn===where.consoleUrn?{...row,agent}:null;},
    create:async({data})=>{const row={status:"pending",responseEnvelope:null,...data};rows.set(row.id,row);return row;},
    updateMany:async({where,data})=>{if(failWrite)throw new Error("disk failure");const row=rows.get(where.id);if(row.responseEnvelope===where.responseEnvelope)Object.assign(row,data);},
  }};
  const fake={ControlError:transport.ControlError,consoleKeys:()=>({}),encodeControl:async(_user,r)=>JSON.stringify(r),
    submitEnvelope:async(_user,wire)=>{sent.push(wire);if(failSend)throw new Error("uncertain send");},
    verifyConsoleEnvelope:(_user,wire)=>{const decoded=JSON.parse(wire);if(decoded.invalidSignature)throw new Error("Invalid signature");return decoded.envelope;},
    decodeControl:(_user,wire)=>{const decoded=JSON.parse(wire);if(decoded.ordinaryChat)throw new Error("Not control");return decoded;},retrieveEnvelopes:async()=>mailbox.slice(0,100),
    acknowledgeEnvelopes:async(_user,ids)=>{acked.push(...ids);mailbox=mailbox.filter(item=>!ids.includes(item.message_id));}};
  const service=load("../src/lib/control-service.ts",{"./db":{prisma},"./control-protocol":protocol,"./control-transport":fake});
  const call={request_id:crypto.randomUUID(),method:"contacts.list",params:{}};
  function reply(id=call.request_id,changes={}) {
    const row=rows.get(id),r=JSON.parse(row.requestEnvelope);
    const decoded={envelope:{senderUrn:agent.urn,messageId:"reply-"+id},chat:{inReplyTo:id,deadline:r.deadline},response:response(r),...changes};
    return {message_id:decoded.envelope.messageId,payload_proto:JSON.stringify(decoded)};
  }
  return {service,rows,sent,acked,user,agent,call,reply,setMailbox:value=>mailbox=value,setFailSend:value=>failSend=value,setFailWrite:value=>failWrite=value};
}

test("an uncertain send retries the identical persisted ciphertext and never claims agent success",async()=>{
  const f=serviceFixture();f.setFailSend(true);
  await assert.rejects(f.service.createControlCall(f.user,f.agent,f.call),/uncertain/);
  f.setFailSend(false);const result=await f.service.createControlCall(f.user,f.agent,f.call);
  assert.equal(result.status,"pending");assert.equal(f.sent.length,2);assert.equal(f.sent[0],f.sent[1]);
  await assert.rejects(f.service.createControlCall(f.user,f.agent,{...f.call,params:{changed:true}}),/请求 ID/);
  await assert.rejects(f.service.createControlCall({...f.user,virtualUrn:"other-console"},f.agent,f.call),/请求 ID/);
});

test("authenticated result is persisted before ACK and pending is not a successful result",async()=>{
  const f=serviceFixture();await f.service.createControlCall(f.user,f.agent,f.call);
  f.setMailbox([f.reply()]);f.setFailWrite(true);await assert.rejects(f.service.pollControlResponses(f.user),/disk failure/);assert.equal(f.acked.length,0);
  f.setFailWrite(false);await f.service.pollControlResponses(f.user);
  const row=f.rows.get(f.call.request_id);assert.equal(row.status,"complete");assert.equal(f.acked.length,1);
  assert.equal(f.service.controlCallResult(f.user,f.agent,row).response.type,"response");
  f.setMailbox([f.reply()]);await f.service.pollControlResponses(f.user);assert.equal(f.acked.length,2,"duplicate response is safely re-ACKed");
});

test("authenticated but unrelated or mismatched responses are discarded without updating a call",async()=>{
  for(const change of ["sender","destination","request","metadata","method","deadline"]){
    const f=serviceFixture();await f.service.createControlCall(f.user,f.agent,f.call);
    const item=f.reply(),decoded=JSON.parse(item.payload_proto);
    if(change==="sender")decoded.envelope.senderUrn="attacker";
    if(change==="destination")decoded.response.console_urn="other-owner";
    if(change==="request")decoded.response.request_id="other-request";
    if(change==="metadata")decoded.chat.inReplyTo="other-request";
    if(change==="method")decoded.response.method="approval.resolve";
    if(change==="deadline")decoded.chat.deadline="2099-01-01T00:00:00Z";
    item.payload_proto=JSON.stringify(decoded);f.setMailbox([item]);await f.service.pollControlResponses(f.user);
    assert.equal(f.rows.get(f.call.request_id).status,"pending",change);assert.equal(f.acked.length,1,change);
  }
});

test("over one batch of authenticated old chat cannot block a legitimate control response",async()=>{
  const f=serviceFixture();await f.service.createControlCall(f.user,f.agent,f.call);
  const unrelated=Array.from({length:101},(_,index)=>({message_id:"old-"+index,payload_proto:JSON.stringify({envelope:{messageId:"old-"+index,senderUrn:"other-peer"},ordinaryChat:true})}));
  f.setMailbox([...unrelated,f.reply()]);await f.service.pollControlResponses(f.user);
  assert.equal(f.acked.length,100);assert.equal(f.rows.get(f.call.request_id).status,"pending");
  await f.service.pollControlResponses(f.user);assert.equal(f.acked.length,102);assert.equal(f.rows.get(f.call.request_id).status,"complete");
});

test("invalid signatures and outer message ID substitutions are never acknowledged",async()=>{
  const f=serviceFixture();await f.service.createControlCall(f.user,f.agent,f.call);
  const invalid=f.reply(),changed=JSON.parse(invalid.payload_proto);changed.invalidSignature=true;invalid.payload_proto=JSON.stringify(changed);
  const swapped=f.reply();swapped.message_id="substituted";
  f.setMailbox([invalid,swapped]);await f.service.pollControlResponses(f.user);assert.equal(f.acked.length,0);assert.equal(f.rows.get(f.call.request_id).status,"pending");
});

test("late responses cannot resurrect expired calls and cache expires independently",async()=>{
  const f=serviceFixture();await f.service.createControlCall(f.user,f.agent,f.call);
  const row=f.rows.get(f.call.request_id);row.deadline=new Date(Date.now()-1000);
  const original=JSON.parse(row.requestEnvelope);original.deadline=row.deadline.toISOString();row.requestEnvelope=JSON.stringify(original);
  f.setMailbox([f.reply()]);await f.service.pollControlResponses(f.user);
  assert.equal(row.responseEnvelope,null);assert.equal(f.acked.length,1);
  assert.equal(f.service.controlCallResult(f.user,f.agent,row).status,"expired");
  await assert.rejects(f.service.createControlCall(f.user,f.agent,f.call),/到期/);
  row.expiresAt=new Date(Date.now()-1000);await f.service.cleanupControlCache();assert.equal(f.rows.size,0);
});

test("the active Web schema and routes contain no independent business stores",()=>{
  const schema=fs.readFileSync(path.resolve(__dirname,"../prisma/schema.prisma"),"utf8");
  for(const model of ["Contact","Message","HITLRequest","Transaction"])assert.doesNotMatch(schema,new RegExp("model\\s+"+model+"\\b"));
  const migration=fs.readFileSync(path.resolve(__dirname,"../prisma/remote-console.sql"),"utf8");
  assert.doesNotMatch(migration,/^\s*(DROP\s+TABLE|DELETE|ALTER)\s/im);
  for(const route of ["contacts","messages","hitl","oncall","transactions"])assert.equal(fs.existsSync(path.resolve(__dirname,"../src/app/api",route,"route.ts")),false);
});
