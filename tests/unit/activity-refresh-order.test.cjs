const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),test=require("node:test"),ts=require("typescript");
function load(relative,deps={}){const filename=path.resolve(__dirname,relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m.require=name=>Object.hasOwn(deps,name)?deps[name]:Module.prototype.require.call(m,name);m._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,filename);return m.exports;}
const client=load("../../src/lib/control/workbench-client.ts");
test("an older activity poll cannot restore a deleted cooperation after the mutation refresh already hid it",async()=>{
 const callbacks=[],slots=[],pending=[];
 const react={useRef:value=>({current:value}),useEffect:()=>{},useCallback:fn=>{callbacks.push(fn);return fn;},useState:initial=>{const value=typeof initial==="function"?initial():initial,slot={initial:value,value};slots.push(slot);return [value,next=>{slot.value=typeof next==="function"?next(slot.value):next;}];}};
 const {WorkspaceHub}=load("../../src/components/workspace-hub.tsx",{"react":react,"next/link":{},"next/navigation":{useRouter:()=>({push:()=>{}}),useSearchParams:()=>new URLSearchParams()},"@/components/ui/input":{},"@/components/ui/button":{},"@/components/local-time":{useLocalTime:()=>()=>"time"},"@/components/workspace-provider":{workspaceRequest:()=>new Promise(resolve=>pending.push(resolve))},"@/components/remote-workbench":{},"@/lib/control/workbench-client":client,"@/components/workbench/record-actions":{isRecordDeleted:()=>false,recordDeletionReason:()=>undefined}});
 const initialAgents=[];WorkspaceHub({initial:{agents:initialAgents},mode:"collaborations"});
 const refresh=callbacks[0],poll=refresh(),changed=refresh();assert.equal(pending.length,2);
 const latest=[{workspace:{agent:{id:"own-agent"},recordStates:[{kind:"collaboration",id:"task",deleted:true,updatedAt:200}]},items:[]}];
 pending[1]({agents:latest});await changed;
 const old=[{workspace:{agent:{id:"own-agent"},recordStates:[]},items:[{id:"task",title:"Previously visible"}]}];
 pending[0]({agents:old});await poll;
 assert.equal(slots.find(slot=>slot.initial===initialAgents).value,latest);
});

function eventFixture() {
 const callbacks=[],effects=[],slots=[],pending=[],listeners=new Map();
 const previousWindow=global.window;
 global.window={addEventListener:(type,listener)=>listeners.set(type,listener),removeEventListener:(type)=>listeners.delete(type)};
 const react={useRef:value=>({current:value}),useEffect:fn=>effects.push(fn),useCallback:fn=>{callbacks.push(fn);return fn;},useState:initial=>{const value=typeof initial==="function"?initial():initial,slot={initial:value,value};slots.push(slot);return [value,next=>{slot.value=typeof next==="function"?next(slot.value):next;}];}};
 const {WorkspaceHub}=load("../../src/components/workspace-hub.tsx",{"react":react,"next/link":{},"next/navigation":{useRouter:()=>({push:()=>{}}),useSearchParams:()=>new URLSearchParams()},"@/components/ui/input":{},"@/components/ui/button":{},"@/components/local-time":{useLocalTime:()=>()=>"time"},"@/components/workspace-provider":{workspaceRequest:()=>new Promise(resolve=>pending.push(resolve))},"@/components/remote-workbench":{},"@/lib/control/workbench-client":client,"@/components/workbench/record-actions":{isRecordDeleted:()=>false,recordDeletionReason:()=>undefined}});
 const initialAgents=[{workspace:{agent:{id:"own-agent",name:"Own"},snapshots:{},recordStates:[{kind:"collaboration",id:"task",deleted:false,updatedAt:1,title:"Saved title",relatedIds:["task","collab"]}]},items:[]}];
 WorkspaceHub({initial:{agents:initialAgents},mode:"collaborations"});
 const cleanup=effects[1]();
 return {pending,refresh:callbacks[0],agents:()=>slots.find(slot=>slot.initial===initialAgents).value,emit:detail=>listeners.get("workspace-records-changed")({detail}),stop:()=>{cleanup();if(previousWindow===undefined)delete global.window;else global.window=previousWindow;}};
}
test("confirmed deletion and restoration update the parent immediately while activity GET remains pending",async()=>{
 const f=eventFixture();try {
  const oldPoll=f.refresh();assert.equal(f.pending.length,1);
  f.emit({agentId:"own-agent",state:{kind:"collaboration",id:"task",deleted:true,updatedAt:200}});
  const deleted=f.agents()[0].workspace.recordStates[0];
  assert.equal(deleted.deleted,true,"the parent must hide the confirmed record before any GET completes");
  assert.equal(deleted.title,"Saved title");assert.deepEqual(deleted.relatedIds,["task","collab"]);
  assert.equal(f.pending.length,2);
  f.pending[0]({agents:[{workspace:{agent:{id:"own-agent"},recordStates:[]},items:[]}]});await oldPoll;
  assert.equal(f.agents()[0].workspace.recordStates[0].deleted,true,"a pre-deletion read cannot undo the event");
  f.emit({agentId:"own-agent",state:{kind:"collaboration",id:"task",deleted:false,updatedAt:300,title:"Restored title",relatedIds:["task","new-alias"]}});
  const restored=f.agents()[0].workspace.recordStates[0];assert.equal(restored.deleted,false);
  assert.equal(restored.title,"Restored title");assert.deepEqual(new Set(restored.relatedIds),new Set(["task","collab","new-alias"]));
  f.pending[1]({agents:[{workspace:{agent:{id:"own-agent"},recordStates:[deleted]},items:[]}]});await Promise.resolve();await Promise.resolve();
  assert.equal(f.agents()[0].workspace.recordStates[0].deleted,false,"the earlier deletion refresh cannot undo restoration");
 }finally{f.stop();}
});
test("record events cannot add a foreign account connection or replace a newer confirmed state",async()=>{
 const f=eventFixture();try {
  f.emit({agentId:"foreign-agent",state:{kind:"contact",id:"friend",deleted:true,updatedAt:500}});
  assert.equal(f.pending.length,0);assert.equal(f.agents().length,1);assert.equal(f.agents()[0].workspace.agent.id,"own-agent");
  f.emit({agentId:"own-agent",state:{kind:"collaboration",id:"task",deleted:true,updatedAt:200}});
  f.emit({agentId:"own-agent",state:{kind:"collaboration",id:"task",deleted:false,updatedAt:100}});
  assert.equal(f.agents()[0].workspace.recordStates[0].deleted,true,"a stale event cannot undo a more recent write");
 }finally{f.stop();}
});
