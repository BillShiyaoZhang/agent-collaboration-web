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
