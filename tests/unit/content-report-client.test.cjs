const assert=require('node:assert/strict'),test=require('node:test'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
function load(relative,deps={},append='') {const filename=path.resolve(__dirname,relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m.require=name=>Object.hasOwn(deps,name)?deps[name]:Module.prototype.require.call(m,name);m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText+append,filename);return m.exports;}
const client=load('../../src/lib/product/content-report-client.ts'),session={accountId:'owner-a',loginSessionId:'login-a',sessionVersion:2};
const scope={...session,origin:'https://test.invalid',agentId:'agent-a',target:{kind:'inbox',id:'message-a'}};
const request={reportId:'a89c158e-8ae0-4c5d-8e91-c87b6b7a08d5',agentId:scope.agentId,target:scope.target,reason:'harassment',comment:'The exact comment',evidence:'Selected evidence',previewToken:'token',consent:true};
const receipt={id:request.reportId,agentId:request.agentId,target:request.target,reason:request.reason,status:'pending',response:''};
function storage() {const map=new Map();return{map,getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),removeItem:key=>map.delete(key)};}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done});return{promise,resolve};}
test('unknown report journal restores the exact request and isolates account, Agent and record',()=>{
 const s=storage();client.createReportJournal(s,scope).save(request);
 assert.deepEqual(client.createReportJournal(s,scope).read(),request);
 for(const next of [{...scope,accountId:'owner-b'},{...scope,agentId:'agent-b'},{...scope,target:{...scope.target,id:'message-b'}}])assert.equal(client.createReportJournal(s,next).read(),null);
 client.createReportJournal(s,scope).clear(request);assert.equal(s.map.size,0);
});
test('denied or corrupted local recovery cannot silently authorize a submission',async()=>{
 const denied={getItem(){throw Error('storage denied')},setItem(){throw Error('storage denied')},removeItem(){}};
 assert.throws(()=>client.createReportJournal(denied,scope).save(request));
 const s=storage();const journal=client.createReportJournal(s,scope);journal.save(request);s.map.set([...s.map.keys()][0],JSON.stringify({...request,agentId:'different-agent'}));assert.throws(()=>journal.read());
 let calls=0;await assert.rejects(client.submitReportOnce({...request,comment:'字'.repeat(667)},async()=>{calls++;return Response.json({report:receipt})}));assert.equal(calls,0);
});
test('lost, nonfinal and mismatched report replies stay unknown after exactly one HTTP call',async()=>{
 for(const reply of [()=>{throw Error('lost reply')},()=>Response.json({report:receipt},{status:202}),()=>Response.json({report:receipt},{status:500}),()=>Response.json({report:{...receipt,agentId:'different-agent'}}),()=>Response.json({report:{...receipt,reason:'spam'}}),()=>Response.json({report:{...receipt,target:{...receipt.target,id:'different'}}}),()=>Response.json({report:{...receipt,status:'unrecognized'}})]) {
  let calls=0;const result=await client.submitReportOnce(request,async(_url,init)=>{calls++;assert.deepEqual(JSON.parse(init.body),request);return reply()});assert.equal(result.state,'uncertain');assert.equal(calls,1);
 }
});
test('a strict accepted receipt and explicit rejection have distinct outcomes',async()=>{
 assert.equal((await client.submitReportOnce(request,async()=>Response.json({report:receipt}))).state,'accepted');
 for(const status of [400,401,403,404,409,413,429])assert.equal((await client.submitReportOnce(request,async()=>Response.json({error:'Rejected'},{status}))).state,'rejected');
});
test('scope guard never revives after account change or a disposed late verification',async()=>{
 let actual=session;const gate=client.createReportScopeGuard(scope,async()=>actual,()=>scope.origin);assert.equal(await gate.current(),true);
 actual={...session,accountId:'owner-b'};assert.equal(await gate.current(),false);actual=session;assert.equal(await gate.current(),false);
 const pause=deferred(),old=client.createReportScopeGuard(scope,()=>pause.promise,()=>scope.origin),checking=old.current();old.dispose();pause.resolve(session);assert.equal(await checking,false);
 for(const changed of [{...session,loginSessionId:'login-b'},{...session,sessionVersion:3},null])assert.equal(await client.createReportScopeGuard(scope,async()=>changed,()=>scope.origin).current(),false);
});
test('cross-tab lock and immutable journal preserve the first unknown original ID',async()=>{
 const s=storage(),journal=client.createReportJournal(s,scope),pause=deferred();let held=false,secondRan=false;
 const locks={async request(_key,_options,operation){if(held)return operation(null);held=true;try{return await operation({})}finally{held=false}}};
 const first=client.withReportTargetLock(scope,locks,async()=>{journal.save(request);await pause.promise});
 await assert.rejects(client.withReportTargetLock(scope,locks,async()=>{secondRan=true}));assert.equal(secondRan,false);pause.resolve();await first;
 assert.throws(()=>journal.save({...request,reportId:'ed9c158e-8ae0-4c5d-8e91-c87b6b7a08d5'}));assert.deepEqual(journal.read(),request);
 await assert.rejects(client.withReportTargetLock(scope,undefined,async()=>{}));
 assert.equal(client.validReportRequest({...request,reason:['harassment']}),false);assert.equal(client.validReportReceipt({...receipt,status:['pending']},request.reportId,request),false);
});
test('late reconciliation cannot blindly clear a different new unknown request',()=>{
 const s=storage(),journal=client.createReportJournal(s,scope),second={...request,reportId:'ed9c158e-8ae0-4c5d-8e91-c87b6b7a08d5'};
 journal.save(request);journal.clear(request);journal.save(second);assert.throws(()=>journal.clear(request));assert.deepEqual(journal.read(),second);
});

function hooks() {const slots=[],pending=[],cleanups=[];let index=0;return {React:{useState(initial){const key=index++;if(!(key in slots))slots[key]=typeof initial==='function'?initial():initial;return[slots[key],next=>{slots[key]=typeof next==='function'?next(slots[key]):next}]},useRef(initial){const key=index++;if(!(key in slots))slots[key]={current:initial};return slots[key]},useCallback(fn){index++;return fn},useEffect(callback,deps){const key=index++;if(!slots[key]||deps.some((value,i)=>!Object.is(value,slots[key][i]))){slots[key]=deps;pending.push(callback)}}},render(fn){index=0;return fn()},flush(){for(const fn of pending.splice(0)){const cleanup=fn();if(cleanup)cleanups.push(cleanup)}},close(){for(const fn of cleanups)fn()}};}
function text(node){if(node==null)return'';if(typeof node!=='object')return String(node);if(Array.isArray(node))return node.map(text).join('');return text(node.props?.children)}
function find(node,label){if(!node||typeof node!=='object')return null;if(Array.isArray(node)){for(const next of node){const match=find(next,label);if(match)return match}return null}if(node.type==='button'&&text(node)===label)return node;return find(node.props?.children,label)}
async function settle(){for(let i=0;i<8;i++)await new Promise(done=>setImmediate(done));}
function uiFixture() {
 const runtime=hooks(),s=storage(),events=new Map();let actual={...session};const old={fetch:global.fetch,window:global.window,localStorage:global.localStorage};
 const locks=global.navigator?.locks;global.navigator.locks={request:async(_key,_options,operation)=>operation({})};
 global.localStorage=s;global.window={location:{origin:scope.origin},addEventListener:(type,fn)=>events.set(type,fn),removeEventListener:type=>events.delete(type)};
 const jsx=(type,props,key)=>({type,props,key});const ui=load('../../src/components/workbench/report-button.tsx',{react:runtime.React,'react/jsx-runtime':{jsx,jsxs:jsx,Fragment:'fragment'},'next-auth/react':{getSession:async()=>actual?{user:{id:actual.accountId,loginSessionId:actual.loginSessionId,sessionVersion:actual.sessionVersion}}:null},'next/link':{default:'link'},'@/components/ui/button':{Button:'button'},'@/components/ui/textarea':{Textarea:'textarea'},'@/components/ui/dialog':{Dialog:'dialog',DialogContent:'content',DialogTitle:'title',DialogDescription:'description'},'@/components/workspace-provider':{useWorkspace:()=>({accountId:session.accountId,sessionVersion:session.sessionVersion})},'@/lib/product/content-report-client':client},'\nexports.TestReportForm=ReportForm;');
 let closed=false;return {s,events,setSession(value){actual=value},render(){const tree=runtime.render(()=>ui.TestReportForm({accountId:session.accountId,sessionVersion:session.sessionVersion,agentId:scope.agentId,target:scope.target}));runtime.flush();return tree},close(){if(closed)return;closed=true;runtime.close();global.navigator.locks=locks;Object.assign(global,old)}};
}
test('real report form saves before delivery and restores the same unknown ID after recreation',async()=>{
 const f=uiFixture();let delivered,order=[];const originalSet=f.s.setItem;f.s.setItem=(key,value)=>{order.push('saved');originalSet(key,value)};
 global.fetch=async(url,init)=>{if(url.endsWith('/preview'))return Response.json({reportId:JSON.parse(init.body).reportId,evidence:'Approved evidence',previewToken:'token'});order.push('delivered');delivered=JSON.parse(init.body);throw Error('lost reply')};
 try {
  find(f.render(),'举报内容').props.onClick();await settle();let tree=f.render();
  const content=JSON.stringify(tree);assert.match(content,/Approved evidence/);
  function choose(node){if(!node||typeof node!=='object')return;if(Array.isArray(node))return node.forEach(choose);if(node.type==='input'&&node.props.type==='checkbox'&&node.props.checked===false)node.props.onChange({target:{checked:true}});choose(node.props?.children)}choose(tree);tree=f.render();
  find(tree,'确认提交举报').props.onClick();await settle();tree=f.render();assert.deepEqual(order,['saved','delivered']);assert.ok(find(tree,'核实原举报'));assert.equal(f.s.map.size,1);
  const stored=JSON.parse([...f.s.map.values()][0]);assert.deepEqual(stored,delivered);const id=stored.reportId;
  // A new component uses the same durable browser storage, with no new preview or POST.
  f.close();const resumed=uiFixture();for(const[key,value]of f.s.map)resumed.s.map.set(key,value);let requests=0;global.fetch=async()=>{requests++;throw Error('unexpected request')};
  try{find(resumed.render(),'举报内容').props.onClick();await settle();const restored=resumed.render();assert.match(text(restored),new RegExp(id));assert.ok(find(restored,'核实原举报'));assert.equal(requests,0)}finally{resumed.close()}
 } finally {f.close()}
});
test('real report form hides old evidence after a changed login and refuses a later submission',async()=>{
 const f=uiFixture();let posts=0;global.fetch=async(url,init)=>{if(url.endsWith('/preview'))return Response.json({reportId:JSON.parse(init.body).reportId,evidence:'Private old evidence',previewToken:'token'});posts++;return Response.json({report:receipt})};
 try{find(f.render(),'举报内容').props.onClick();await settle();let tree=f.render();assert.match(text(tree),/Private old evidence/);f.setSession({...session,loginSessionId:'new-login'});f.events.get('focus')();await settle();tree=f.render();assert.doesNotMatch(text(tree),/Private old evidence/);assert.equal(find(tree,'确认提交举报'),null);assert.equal(posts,0)}finally{f.close()}
});
test('late preview cannot reveal evidence after a newer blur',async()=>{
 const f=uiFixture(),pause=deferred();let previewId;
 global.fetch=async(_url,init)=>{previewId=JSON.parse(init.body).reportId;await pause.promise;return Response.json({reportId:previewId,evidence:'Hidden while unfocused',previewToken:'token'})};
 try{find(f.render(),'举报内容').props.onClick();await settle();f.render();f.events.get('blur')();pause.resolve();await settle();assert.doesNotMatch(text(f.render()),/Hidden while unfocused/)}finally{f.close()}
});
test('an old preview cannot reappear after blur then focus while it is pending',async()=>{
 const f=uiFixture(),pause=deferred();let previewId;
 global.fetch=async(_url,init)=>{previewId=JSON.parse(init.body).reportId;await pause.promise;return Response.json({reportId:previewId,evidence:'Old delayed preview',previewToken:'token'})};
 try{find(f.render(),'举报内容').props.onClick();await settle();f.render();f.events.get('blur')();f.events.get('focus')();await settle();pause.resolve();await settle();assert.doesNotMatch(text(f.render()),/Old delayed preview/)}finally{f.close()}
});
test('explicit rejection with failed cleanup locks the original recovery instead of editable fields',async()=>{
 const f=uiFixture();global.fetch=async(url,init)=>url.endsWith('/preview')?Response.json({reportId:JSON.parse(init.body).reportId,evidence:'Evidence',previewToken:'token'}):Response.json({error:'Rejected'},{status:403});
 try{find(f.render(),'举报内容').props.onClick();await settle();let tree=f.render();
  function agree(node){if(!node||typeof node!=='object')return;if(Array.isArray(node))return node.forEach(agree);if(node.type==='input'&&node.props.type==='checkbox')node.props.onChange({target:{checked:true}});agree(node.props?.children)}agree(tree);tree=f.render();f.s.removeItem=()=>{throw Error('cleanup denied')};find(tree,'确认提交举报').props.onClick();await settle();tree=f.render();assert.ok(find(tree,'核实原举报'));assert.equal(find(tree,'确认提交举报'),null);assert.equal(f.s.map.size,1);
 }finally{f.close()}
});
