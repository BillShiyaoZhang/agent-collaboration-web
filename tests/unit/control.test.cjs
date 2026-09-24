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
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : name === "@/lib/shared/http-input" ? load("../../src/lib/shared/http-input.ts") : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);
  return loaded.exports;
}
const protocol = load("../../src/lib/control/control-protocol.ts");
const proto = load("../../src/lib/protocol/proto.ts");
const auth = load("../../src/lib/protocol/protocol-auth.ts",{"@/lib/protocol/proto":proto});
const keys = load("../../src/lib/protocol/crypto.ts");
const ecies = load("../../src/lib/protocol/ecies.ts");
const managedGateCalls=[];
class PolicyConsentRequiredError extends Error {}
let managedGateFailure=null;
const transport = load("../../src/lib/control/control-transport.ts",{"@/lib/protocol/proto":proto,"@/lib/protocol/protocol-auth":auth,"@/lib/protocol/crypto":keys,"@/lib/protocol/ecies":ecies,
  "@/lib/control/v2-policy":{PolicyConsentRequiredError,requireManagedV1:async(_user,_keys,force=false)=>{managedGateCalls.push(force);if(managedGateFailure)throw managedGateFailure;}}});
const pollMetrics = load("../../src/lib/control/control-poll-metrics.ts");
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

test("contact and approval actions accept only explicit scoped parameters", () => {
  const parse = (method, params) => protocol.controlCallSchema.safeParse({ request_id: crypto.randomUUID(), method, params }).success;
  const contact = { contact_id: "contact-a", aliases: ["小王"], urn: "urn:hermes:agent:friend" };
  assert.equal(parse("contacts.add", contact), true);
  for (const params of [{ ...contact, contact_id: "self" }, { ...contact, contact_id: "friend\n" }, { ...contact, aliases: [] },
    { ...contact, aliases: [" "] }, { ...contact, aliases: Array(17).fill("name") }, { ...contact, urn: "friend" },
    { ...contact, urn: contact.urn + "\n" }, { ...contact, owner_principal: "other-owner" }]) assert.equal(parse("contacts.add", params), false);
  for (const decision of ["approve", "deny"]) assert.equal(parse("approval.respond", { approval_id: "approval-one", decision }), true);
  for (const params of [{ approval_id: "approval-one", approved: true }, { approval_id: "approval-one", decision: "allow" },
    { approval_id: "", decision: "approve" }, { approval_id: "approval-one", decision: "approve", owner_session: "injected" }])
    assert.equal(parse("approval.respond", params), false);
});

test("the actual RPC route enforces session, saved connection and origin before dispatch",async()=>{
  const original=process.env.NEXTAUTH_URL;process.env.NEXTAUTH_URL="https://console.example";
  let session=null,called=0;
  const user={id:"owner"},agent={id:"my-agent",userId:"owner",urn:"urn:my:agent"};
  const route=load("../../src/app/api/agents/[id]/control/route.ts",{
    "next-auth":{getServerSession:async()=>session},"@/lib/auth/auth":{authOptions:{}},
    "@/lib/shared/db":{prisma:{agent:{findFirst:async({where})=>where.id===agent.id&&where.userId===agent.userId?agent:null},user:{findUnique:async()=>user}}},
    "@/lib/control/control-protocol":protocol,"@/lib/control/control-transport":transport,
    "@/lib/control/control-poll-metrics":pollMetrics,
    "@/lib/workspace/workspace-store":{recordWorkspaceResponse:async()=>{}},
    "@/lib/control/control-service":{createControlCall:async(_user,target,call)=>{called++;assert.equal(target.urn,agent.urn);return {request_id:call.request_id,status:"pending"};}},
  });
  const body={request_id:crypto.randomUUID(),method:"capabilities",params:{}};
  const req=(data=body,origin="https://console.example")=>new Request("https://console.example/api/agents/my-agent/control",{method:"POST",headers:{origin,"Content-Type":"application/json"},body:JSON.stringify(data)});
  try {
    assert.equal((await route.POST(req(),{params:{id:agent.id}})).status,401);
    session={user:{id:"owner"}};
    assert.equal((await route.POST(req(),{params:{id:"someone-else"}})).status,404);
    assert.equal((await route.POST(req(body,"https://attacker.example"),{params:{id:agent.id}})).status,403);
    assert.equal((await route.POST(req({...body,agent_urn:"injected"}),{params:{id:agent.id}})).status,400);
    let pulls=0,cancelled=false;
    const stream=new ReadableStream({pull(controller){pulls++;controller.enqueue(new Uint8Array(16384));},cancel(){cancelled=true;}},{highWaterMark:0});
    const oversized=new Request("https://console.example/api/agents/my-agent/control",{method:"POST",headers:{origin:"https://console.example","content-length":"1"},body:stream,duplex:"half"});
    assert.equal((await route.POST(oversized,{params:{id:agent.id}})).status,413);
    assert.equal(pulls,3);assert.equal(cancelled,true);
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

test("a missing managed grant re-enrolls once and resends the identical v1 envelope", async () => {
  const originalSecret=process.env.NEXTAUTH_SECRET, originalFetch=global.fetch;
  process.env.NEXTAUTH_SECRET="managed-grant-retry-test";
  managedGateCalls.length=0;
  try {
    const owner=identity(), user=userFor(owner), recipient="urn:agent-comm:agent:recipient";
    const signed=auth.signEnvelope({senderUrn:owner.urn,recipientUrn:recipient,
      senderStaticPubkey:owner.xRaw,ephemeralPubkey:Buffer.alloc(32,1),nonce:Buffer.alloc(12,2),
      ciphertext:Buffer.from("same wire"),tag:Buffer.alloc(16,3),messageId:"managed-retry"},owner.ed.privateKey);
    const envelope=proto.encodeEncryptedEnvelope(signed).toString("base64"), bodies=[];
    global.fetch=async(url,init)=>{
      assert.ok(url.endsWith("/api/v1/mq/store"));
      bodies.push(init.body);
      return bodies.length===1 ? Response.json({error:"grant not registered"},{status:400})
        : Response.json({ok:true,message_id:"managed-retry"});
    };
    await transport.submitEnvelope(user,envelope,recipient,new Date(Date.now()+60000));
    assert.deepEqual(managedGateCalls,[false,true]);
    assert.equal(bodies.length,2);
    assert.equal(bodies[0],bodies[1]);
    assert.equal(JSON.parse(bodies[0]).payload_proto,envelope);
  } finally {
    global.fetch=originalFetch;
    if(originalSecret===undefined)delete process.env.NEXTAUTH_SECRET;else process.env.NEXTAUTH_SECRET=originalSecret;
  }
});

test("managed transport marks consent and certificate faults without contacting MQ", async () => {
  const originalSecret=process.env.NEXTAUTH_SECRET, originalFetch=global.fetch;
  process.env.NEXTAUTH_SECRET="managed-gate-fault-test";
  let requests=0;
  global.fetch=async()=>{requests++;throw new Error("MQ should not be contacted");};
  try {
    const user=userFor(identity());
    for(const [failure,reason,status] of [
      [new PolicyConsentRequiredError("confirm policy"),"policy_paused",409],
      [new Error("issuer mismatch"),"policy_unavailable",503],
    ]) {
      managedGateFailure=failure;
      await assert.rejects(transport.retrieveEnvelopes(user),error=>error instanceof transport.ControlError &&
        error.reason===reason && error.status===status);
    }
    assert.equal(requests,0);
  } finally {
    managedGateFailure=null;global.fetch=originalFetch;
    if(originalSecret===undefined)delete process.env.NEXTAUTH_SECRET;else process.env.NEXTAUTH_SECRET=originalSecret;
  }
});

function serviceFixture() {
  const rows=new Map(),sent=[],acked=[],projected=[];let mailbox=[],failSend=false,failWrite=false,failProjection=false,retrievals=0,cacheDeletes=0;
  let policyAllowed=true;
  class PolicyConsentRequiredError extends Error {}
  const user={id:"owner",virtualUrn:"console"},agent={id:"agent",urn:"agent-urn",userId:user.id};
  const prisma={controlRequest:{
    deleteMany:async({where})=>{cacheDeletes++;for(const [id,row] of rows)if(row.expiresAt<=where.expiresAt.lte)rows.delete(id);},
    count:async({where})=>[...rows.values()].filter(row=>!where?.expiresAt||row.expiresAt>where.expiresAt.gt).length,
    findUnique:async({where})=>rows.get(where.id)||null,
    findFirst:async({where})=>where.expiresAt?[...rows.values()].find(row=>row.expiresAt<=where.expiresAt.lte)||null:(()=>{const row=rows.get(where.id);return row&&where.agent.userId===user.id&&row.consoleUrn===where.consoleUrn?{...row,agent}:null;})(),
    create:async({data})=>{const row={status:"pending",responseEnvelope:null,...data};rows.set(row.id,row);return row;},
    updateMany:async({where,data})=>{if(failWrite)throw new Error("disk failure");const row=rows.get(where.id);if(row.responseEnvelope===where.responseEnvelope){Object.assign(row,data);return {count:1};}return {count:0};},
  }};
  const fake={ControlError:transport.ControlError,consoleKeys:()=>({}),encodeControl:async(_user,r)=>JSON.stringify(r),
    submitEnvelope:async(_user,wire)=>{sent.push(wire);if(failSend)throw new Error("uncertain send");},
    verifyConsoleEnvelope:(_user,wire)=>{const decoded=JSON.parse(wire);if(decoded.invalidSignature)throw new Error("Invalid signature");return decoded.envelope;},
    decodeControl:(_user,wire)=>{const decoded=JSON.parse(wire);if(decoded.ordinaryChat)throw new Error("Not control");return decoded;},retrieveEnvelopes:async()=>{retrievals++;return mailbox.slice(0,100);},
    acknowledgeEnvelopes:async(_user,ids)=>{acked.push(...ids);mailbox=mailbox.filter(item=>!ids.includes(item.message_id));}};
  const store={reserveWorkspaceSubmission:async()=>{},markWorkspaceSubmissionUncertain:async()=>{},clearWorkspaceSubmission:async()=>{},
    recordWorkspaceResponse:async(_user,_agent,row,result)=>{if(failProjection)throw new Error("projection disk failure");projected.push({id:row.id,result});}};
  const service=load("../../src/lib/control/control-service.ts",{"@/lib/shared/db":{prisma},"@/lib/control/control-protocol":protocol,"@/lib/control/control-transport":fake,"@/lib/workspace/workspace-store":store,
    "@/lib/control/v2-policy":{PolicyConsentRequiredError,requirePolicyAcknowledgement:async()=>{if(!policyAllowed)throw new PolicyConsentRequiredError("policy consent required");}}});
  const call={request_id:crypto.randomUUID(),method:"contacts.list",params:{}};
  function reply(id=call.request_id,changes={}) {
    const row=rows.get(id),r=JSON.parse(row.requestEnvelope);
    const decoded={envelope:{senderUrn:agent.urn,messageId:"reply-"+id},chat:{inReplyTo:id,deadline:r.deadline},response:response(r),...changes};
    return {message_id:decoded.envelope.messageId,payload_proto:JSON.stringify(decoded)};
  }
  return {service,rows,sent,acked,projected,user,agent,call,reply,setMailbox:value=>mailbox=value,setFailSend:value=>failSend=value,setFailWrite:value=>failWrite=value,setFailProjection:value=>failProjection=value,setPolicyAllowed:value=>policyAllowed=value,retrievals:()=>retrievals,cacheDeletes:()=>cacheDeletes};
}

test("unacknowledged policy stops a control call before persisting or sending wire bytes",async()=>{
  const f=serviceFixture();f.setPolicyAllowed(false);
  await assert.rejects(f.service.createControlCall(f.user,f.agent,f.call),error=>error.status===409);
  assert.equal(f.rows.size,0);assert.equal(f.sent.length,0);
  f.setPolicyAllowed(true);await f.service.createControlCall(f.user,f.agent,f.call);
  assert.equal(f.sent.length,1);
});

test("durable account projection must finish before ACK, including retry after a wire-only save",async()=>{
  const f=serviceFixture();await f.service.createControlCall(f.user,f.agent,f.call);
  f.setMailbox([f.reply()]);f.setFailProjection(true);
  await assert.rejects(f.service.pollControlResponses(f.user),/projection disk failure/);
  assert.equal(f.rows.get(f.call.request_id).status,"complete");assert.equal(f.acked.length,0);
  f.setFailProjection(false);await f.service.pollControlResponses(f.user);
  assert.equal(f.projected.length,1);assert.equal(f.acked.length,1);
});

test("concurrent browser and worker mailbox reads share one authenticated retrieval",async()=>{
  const f=serviceFixture();await f.service.createControlCall(f.user,f.agent,f.call);f.setMailbox([f.reply()]);
  await Promise.all([f.service.pollControlResponses(f.user),f.service.pollControlResponses(f.user),f.service.pollControlResponses(f.user)]);
  assert.equal(f.retrievals(),1);assert.equal(f.projected.length,1);assert.equal(f.acked.length,1);
});

test("slow control poll logs contain only bounded phase timings",()=>{
  assert.equal(pollMetrics.slowControlPollMetric({totalMs:1999,request_id:"secret-id"}),null);
  const result=pollMetrics.slowControlPollMetric({totalMs:10001,sessionMs:12.6,mqRetrieveMs:9999,mqHttpMs:9980,
    workspaceProjectionMs:NaN,sharedPoll:true,request_id:"secret-id",urn:"secret-urn",ciphertext:"secret-wire"});
  assert.equal(result.event,"slow_control_poll");
  assert.equal(result.total_ms,10001);assert.equal(result.session_ms,13);assert.equal(result.mq_http_ms,9980);
  assert.equal(result.workspace_projection_ms,null);assert.equal(result.shared_poll,true);
  assert.doesNotMatch(JSON.stringify(result),/secret-id|secret-urn|secret-wire/);
});

test("control calls and mailbox polls do not run cache DELETE in the request path",async()=>{
  const f=serviceFixture();
  for(let index=0;index<70;index++)f.rows.set(`expired-${index}`,{expiresAt:new Date(Date.now()-1000)});
  await f.service.createControlCall(f.user,f.agent,f.call);
  f.setMailbox([f.reply()]);await f.service.pollControlResponses(f.user);
  assert.equal(f.rows.get(f.call.request_id).status,"complete");
  assert.equal(f.cacheDeletes(),0,"expired cache rows cannot make a live control poll wait for a SQLite writer");
  await f.service.cleanupControlCache();
  assert.equal(f.cacheDeletes(),1);assert.equal(f.rows.size,1);
  await f.service.cleanupControlCache();assert.equal(f.cacheDeletes(),1,"idle cleanup is read-only");
});

test("concurrent retries of the same write enqueue once and reject a competing payload",async()=>{
  const f=serviceFixture(),call={...f.call,method:'conversation.send',params:{text:'one durable message'}};
  const first=f.service.createControlCall(f.user,f.agent,call);
  const second=f.service.createControlCall(f.user,f.agent,call);
  await assert.rejects(f.service.createControlCall(f.user,f.agent,{...call,params:{text:'changed'}}),/请求 ID/);
  const replies=await Promise.all([first,second]);
  assert.equal(f.sent.length,1);assert.deepEqual(replies[0],replies[1]);
});

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

test("legacy business tables remain untouched and their retired write routes stay closed",()=>{
  const schema=fs.readFileSync(path.resolve(__dirname,"../../prisma/schema.prisma"),"utf8");
  for(const model of ["Contact","Message","HITLRequest","Transaction"])assert.doesNotMatch(schema,new RegExp("model\\s+"+model+"\\b"));
  const migration=fs.readFileSync(path.resolve(__dirname,"../../prisma/remote-console.sql"),"utf8");
  assert.doesNotMatch(migration,/^\s*(DROP\s+TABLE|DELETE|ALTER)\s/im);
  for(const route of ["contacts","messages","hitl","oncall","transactions"])assert.equal(fs.existsSync(path.resolve(__dirname,"../../src/app/api",route,"route.ts")),false);
});

test("reordered cross-client retries preserve legacy ciphertext and all identity/content bindings", async () => {
  for (const originalParams of [{ text: "来自 Web 的原消息", conversation_id: "chat-a" }, { conversation_id: "chat-a", text: "来自 Web 的原消息" }]) {
    const f = serviceFixture(), call = { ...f.call, method: "conversation.send", params: originalParams };
    f.setFailSend(true);
    await assert.rejects(f.service.createControlCall(f.user, f.agent, call), /uncertain/);
    const row = f.rows.get(call.request_id), originalWire = row.requestEnvelope, originalDeadline = row.deadline;
    // Seed the exact fingerprint generated by the previously deployed implementation.
    row.fingerprint = crypto.createHash("sha256").update(JSON.stringify([f.agent.id, f.user.virtualUrn, call.method, originalParams])).digest("hex");
    const reordered = { ...call, params: Object.fromEntries(Object.entries(originalParams).reverse()) };
    assert.notEqual(JSON.stringify(reordered.params), JSON.stringify(originalParams));
    f.setFailSend(false);
    assert.equal((await f.service.createControlCall(f.user, f.agent, reordered)).status, "pending");
    assert.deepEqual(f.sent, [originalWire, originalWire], "cross-client retry must replay the exact saved ciphertext");
    assert.strictEqual(row.deadline, originalDeadline, "retry must not renew the execution deadline");
    for (const params of [{ ...reordered.params, text: "changed" }, { ...reordered.params, conversation_id: "another-chat" }, { ...reordered.params, extra: true }]) {
      await assert.rejects(f.service.createControlCall(f.user, f.agent, { ...reordered, params }), { status: 409 });
    }
    await assert.rejects(f.service.createControlCall(f.user, f.agent, { ...reordered, method: "conversation.get" }), { status: 409 });
    await assert.rejects(f.service.createControlCall({ ...f.user, virtualUrn: "other-console" }, f.agent, reordered), { status: 409 });
    await assert.rejects(f.service.createControlCall(f.user, { ...f.agent, id: "other-agent" }, reordered), { status: 409 });
    assert.equal(f.sent.length, 2, "rejected alternatives must never enqueue");
  }
});

test("simultaneous same-value calls with reordered params share one in-flight operation", async () => {
  const f = serviceFixture(), first = { ...f.call, method: "conversation.send", params: { text: "one message", conversation_id: "chat" } };
  const second = { ...first, params: { conversation_id: "chat", text: "one message" } };
  const [a, b] = await Promise.all([f.service.createControlCall(f.user, f.agent, first), f.service.createControlCall(f.user, f.agent, second)]);
  assert.deepEqual(a, b);
  assert.equal(f.sent.length, 1);
});

test("social RPCs reject injected authority and invalid business identifiers", () => {
  const parse = (method, params) => protocol.controlCallSchema.safeParse({ request_id: crypto.randomUUID(), method, params }).success;
  assert.equal(parse("contacts.requests", {}), true);
  assert.equal(parse("contacts.respond", { request_id: "friend-request", decision: "accept" }), true);
  assert.equal(parse("contacts.respond", { request_id: "friend-request", decision: "reject" }), true);
  assert.equal(parse("messages.send", { recipient_urn: "urn:agent:friend", message_id: "message-1", text: "hello" }), true);
  assert.equal(parse("inbox.mark_read", { message_id: "message-1" }), true);
  for (const [method, params] of [
    ["contacts.respond", { request_id: "friend-request", decision: "approve" }],
    ["contacts.respond", { request_id: "friend-request", decision: "accept", owner: "forged" }],
    ["messages.send", { recipient_urn: "urn:agent:friend", text: " " }],
    ["messages.send", { recipient_urn: "urn:agent:friend", text: "你".repeat(8001) }],
    ["inbox.mark_read", { message_id: "message-1", read_at: 123 }],
    ["collaboration.execute", { action: "confirm", approval_id: "one", answer: "yes" }],
    ["collaboration.execute", { action: "state", owner_session: "forged" }],
  ]) assert.equal(parse(method, params), false);
});
