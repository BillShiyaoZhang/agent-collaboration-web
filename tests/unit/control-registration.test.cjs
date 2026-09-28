const assert=require('node:assert/strict'),crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),test=require('node:test'),ts=require('typescript');
function load(relative,deps={}){const filename=path.resolve(__dirname,relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m.require=name=>Object.hasOwn(deps,name)?deps[name]:Module.prototype.require.call(m,name);m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);return m.exports;}
const proto=load('../../src/lib/protocol/proto.ts'),auth=load('../../src/lib/protocol/protocol-auth.ts',{'@/lib/protocol/proto':proto}),keys=load('../../src/lib/protocol/crypto.ts'),ecies=load('../../src/lib/protocol/ecies.ts');
function identity(){const ed=crypto.generateKeyPairSync('ed25519'),x=crypto.generateKeyPairSync('x25519'),edRaw=ed.publicKey.export({type:'spki',format:'der'}).subarray(-32),xRaw=x.publicKey.export({type:'spki',format:'der'}).subarray(-32);return{ed,x,edRaw,xRaw,urn:keys.deriveUrnFromEd25519PubKey(edRaw.toString('hex')),xPrivate:x.privateKey.export({type:'pkcs8',format:'der'}).subarray(-32)};}
function userFor(owner,id='owner'){return{id,virtualUrn:owner.urn,virtualEd25519PublicKey:owner.edRaw.toString('hex'),virtualX25519PublicKey:owner.xRaw.toString('hex'),virtualEd25519PrivateKey:JSON.stringify(keys.encryptPrivateKey(owner.ed.privateKey.export({type:'pkcs8',format:'der'}).toString('hex'),process.env.NEXTAUTH_SECRET)),virtualX25519PrivateKey:JSON.stringify(keys.encryptPrivateKey(owner.x.privateKey.export({type:'pkcs8',format:'der'}).toString('hex'),process.env.NEXTAUTH_SECRET))};}
function fixture(){let active=true,lookupFailure=false,policyEffect,registerEffect;const owner=identity(),agent=identity(),user=userFor(owner),registry=new Map(),queue=[],events=[],managed=[];let now=Date.now();
 class PolicyConsentRequiredError extends Error{}
 const transport=load('../../src/lib/control/control-transport.ts',{'@/lib/protocol/proto':proto,'@/lib/protocol/protocol-auth':auth,'@/lib/protocol/crypto':keys,'@/lib/protocol/ecies':ecies,'@/lib/shared/db':{prisma:{user:{findUnique:async()=>{if(lookupFailure)throw Error('database offline');return active?{id:user.id}:null;}}}},'@/lib/control/v2-policy':{PolicyConsentRequiredError,requireManagedV1:async(_user,_keys,force=false)=>{managed.push(force);await policyEffect?.();}}});
 function signRegistration(who){const r={urn:who.urn,peerId:auth.peerIdFromEd25519PublicKey(who.edRaw),x25519Pubkey:who.xRaw,ed25519Pubkey:who.edRaw,storesUserData:true,timestamp:Math.floor(now/1000)};return{found:true,urn:r.urn,peer_id:r.peerId,x25519_pubkey:who.xRaw.toString('base64'),ed25519_pubkey:who.edRaw.toString('base64'),stores_user_data:true,timestamp:r.timestamp,signature:crypto.sign(null,auth.buildRegistrationSigningBytes(r),who.ed.privateKey).toString('base64')};}
 async function fetch(url,init={}){const target=new URL(url),body=init.body?JSON.parse(init.body):null;events.push({path:target.pathname,body});
  if(target.pathname==='/api/v1/registry/register'){
   const [signature,publicKey]=init.headers.Authorization.slice('Ed25519 '.length).split(':');assert.equal(publicKey,body.ed25519_pubkey?Buffer.from(body.ed25519_pubkey,'base64').toString('hex'):undefined);
   const pub=crypto.createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(publicKey,'hex')]),format:'der',type:'spki'});assert.ok(crypto.verify(null,Buffer.from(init.body),pub,Buffer.from(signature,'hex')));
   auth.verifyRegistration({urn:body.urn,peerId:body.peer_id,x25519Pubkey:Buffer.from(body.x25519_pubkey,'base64'),ed25519Pubkey:Buffer.from(body.ed25519_pubkey,'base64'),storesUserData:body.stores_user_data,timestamp:body.timestamp,signature:Buffer.from(body.signature,'base64')},body.urn);
   const override=await registerEffect?.(body);if(override)return override;
   registry.set(body.urn,{...body,expires:now+3600000});return Response.json({ok:true});
  }
  if(target.pathname==='/api/v1/registry/resolve')return Response.json(signRegistration(agent));
  if(target.pathname==='/api/v1/mq/store'){
   const envelope=proto.decodeEncryptedEnvelope(Buffer.from(body.payload_proto,'base64'));auth.verifyEnvelope(envelope,agent.urn);
   const plaintext=ecies.decryptWithSharedSecret(ecies.computeSharedSecret(agent.xPrivate,envelope.senderStaticPubkey),envelope.ephemeralPubkey,envelope.nonce,envelope.ciphertext,envelope.tag),request=JSON.parse(proto.decodeChatMessage(plaintext).text);
   assert.equal(request.method,'capabilities');assert.equal(request.request_id,envelope.messageId);assert.equal(request.console_urn,owner.urn);
   const registered=registry.get(owner.urn);
   if(registered&&registered.expires>now){const result={protocol:request.protocol,type:'response',request_id:request.request_id,method:request.method,agent_urn:request.agent_urn,console_urn:request.console_urn,deadline:request.deadline,result:{peer_content_safety:{version:1,mode:'owner_review',automatic_peer_model_execution:false}}};const encoded=proto.encodeChatMessage(JSON.stringify(result),now,{kind:'control.response',inReplyTo:request.request_id,deadline:request.deadline});const encryption=ecies.encryptWithSharedSecret(ecies.computeSharedSecret(agent.xPrivate,Buffer.from(registered.x25519_pubkey,'base64')),encoded);const reply=auth.signEnvelope({senderUrn:agent.urn,recipientUrn:owner.urn,senderStaticPubkey:agent.xRaw,ephemeralPubkey:encryption.ephemeral,nonce:encryption.nonce,ciphertext:encryption.ciphertext,tag:encryption.tag,messageId:'reply-'+request.request_id},agent.ed.privateKey);queue.push({message_id:reply.messageId,payload_proto:proto.encodeEncryptedEnvelope(reply).toString('base64')});}
   return Response.json({ok:true,message_id:envelope.messageId});
  }
  if(target.pathname==='/api/v1/mq/retrieve')return Response.json({messages:queue.splice(0)});
  throw Error('Unexpected isolated platform route');
 }
 return{transport,owner,agent,user,registry,events,managed,fetch,advance(ms){now+=ms;},now:()=>now,setActive(value){active=value;},setLookupFailure(value){lookupFailure=value;},setPolicyEffect(value){policyEffect=value;},setRegisterEffect(value){registerEffect=value;}};
}
async function isolated(run){const secret=process.env.NEXTAUTH_SECRET,originalFetch=global.fetch,clock=Date.now;process.env.NEXTAUTH_SECRET='isolated-original-console-registration';try{const f=fixture();global.fetch=f.fetch;Date.now=f.now;await run(f);}finally{global.fetch=originalFetch;Date.now=clock;if(secret===undefined)delete process.env.NEXTAUTH_SECRET;else process.env.NEXTAUTH_SECRET=secret;}}
test('missing and TTL-expired Console registry recover an encrypted capabilities roundtrip with the same identity',async()=>isolated(async f=>{
 const original=JSON.stringify(f.user);assert.ok(f.transport.CONSOLE_REGISTRATION_REFRESH_MS<=3600000/2);
 for(const missing of [true,false]){
  if(!missing)f.advance(3600001);
  const request={protocol:'agent-comm-control/v1',type:'request',request_id:crypto.randomUUID(),method:'capabilities',params:{},agent_urn:f.agent.urn,console_urn:f.owner.urn,deadline:new Date(Date.now()+120000).toISOString()};
  const wire=await f.transport.encodeControl(f.user,request);await f.transport.submitEnvelope(f.user,wire,f.agent.urn,new Date(request.deadline));const replies=await f.transport.retrieveEnvelopes(f.user);assert.equal(replies.length,1);const response=f.transport.decodeControl(f.user,replies[0].payload_proto).response;
  assert.equal(response.request_id,request.request_id);assert.equal(response.deadline,request.deadline);assert.deepEqual(response.result.peer_content_safety,{version:1,mode:'owner_review',automatic_peer_model_execution:false});
 }
 assert.equal(JSON.stringify(f.user),original);const registrations=f.events.filter(e=>e.path.endsWith('/register'));assert.equal(registrations.length,2);assert.ok(registrations.every(e=>e.body.urn===f.owner.urn&&e.body.x25519_pubkey===f.owner.xRaw.toString('base64')));
}));
test('concurrent send-side registration and retrieval coalesce; five-second polls do not renew again',async()=>isolated(async f=>{
 let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);f.setRegisterEffect(async()=>{entered();await gate;});
 const request={protocol:'agent-comm-control/v1',type:'request',request_id:crypto.randomUUID(),method:'capabilities',params:{},agent_urn:f.agent.urn,console_urn:f.owner.urn,deadline:new Date(Date.now()+120000).toISOString()};const wire=await f.transport.encodeControl(f.user,request);
 const first=f.transport.submitEnvelope(f.user,wire,f.agent.urn,new Date(request.deadline));await started;const second=f.transport.retrieveEnvelopes(f.user);release();await Promise.all([first,second]);
 for(let i=0;i<5;i++){f.advance(5000);await f.transport.retrieveEnvelopes(f.user);}assert.equal(f.events.filter(e=>e.path.endsWith('/register')).length,1);
 f.advance(5001);await f.transport.retrieveEnvelopes(f.user);assert.equal(f.events.filter(e=>e.path.endsWith('/register')).length,2);
}));
test('failed and unconfirmed registration do not populate the short cache; retries recover',async()=>isolated(async f=>{
 let failures=0;f.setRegisterEffect(async()=>{failures++;return failures===1?Response.json({error:'registry offline'},{status:503}):failures===2?Response.json({ok:false}):undefined;});
 await assert.rejects(f.transport.registerConsole(f.user),error=>error.platformStatus===503);await assert.rejects(f.transport.registerConsole(f.user),/未确认/);await f.transport.registerConsole(f.user);await f.transport.registerConsole(f.user);assert.equal(failures,3);
 const before=f.events.length;f.setRegisterEffect(()=>Response.json({error:'backend restarted'},{status:503}));await assert.rejects(f.transport.registerConsole(f.user,true),error=>error.platformStatus===503);f.setRegisterEffect(undefined);await f.transport.registerConsole(f.user);assert.equal(f.events.length,before+2);
}));
test('registration cache binds the account and both public keys, including forced backend recovery',async()=>isolated(async f=>{
 await f.transport.registerConsole(f.user);await f.transport.registerConsole({...f.user,id:'second-owner'});const changed=identity();await f.transport.registerConsole({...f.user,virtualX25519PublicKey:changed.xRaw.toString('hex')});await f.transport.registerConsole(f.user,true);assert.equal(f.events.filter(e=>e.path.endsWith('/register')).length,4);
}));
test('account deletion and database failure stop network work even with a warm cache or awaited registration',async()=>isolated(async f=>{
 await f.transport.registerConsole(f.user);const count=f.events.length;f.setActive(false);await assert.rejects(f.transport.registerConsole(f.user),error=>error.status===401);await assert.rejects(f.transport.retrieveEnvelopes(f.user),error=>error.status===401);assert.equal(f.events.length,count);
 f.setActive(true);f.setLookupFailure(true);await assert.rejects(f.transport.registerConsole(f.user),error=>error.status===503);assert.equal(f.events.length,count);f.setLookupFailure(false);
 f.advance(30001);f.setPolicyEffect(()=>f.setActive(false));await assert.rejects(f.transport.retrieveEnvelopes(f.user),error=>error.status===401);assert.equal(f.events.length,count);
 f.setActive(true);f.setPolicyEffect(undefined);f.setRegisterEffect(()=>{f.setActive(false);return Response.json({ok:true});});await assert.rejects(f.transport.retrieveEnvelopes(f.user),error=>error.status===401);assert.equal(f.events.length,count+1);assert.ok(f.events.at(-1).path.endsWith('/register'));
 // Registration already handed to the network cannot be recalled, but its
 // deleted-account completion must not be cached or followed by mailbox I/O.
 f.setActive(true);f.setRegisterEffect(undefined);await f.transport.registerConsole(f.user);assert.equal(f.events.length,count+2);
}));
