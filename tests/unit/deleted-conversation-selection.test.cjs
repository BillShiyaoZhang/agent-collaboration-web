const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), Module = require("node:module"), test = require("node:test"), ts = require("typescript");
function load(relative, deps={}) {
 const filename=path.resolve(__dirname,relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
 m.require=name=>Object.hasOwn(deps,name)?deps[name]:Module.prototype.require.call(m,name);
 m._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);return m.exports;
}
const client=load("../../src/lib/control/workbench-client.ts"),drafts=load("../../src/lib/product/draft-cache.ts"),queue=load("../../src/lib/product/metadata-queue.ts"),workspaceClient=load("../../src/lib/workspace/workspace-client.ts",{"@/lib/control/workbench-client":client});
function fixture(targetId,deleted=true,request) {
 const slots=[],savedDrafts=[],requests=[],cached=[];
 const react={useRef:value=>({current:value}),useCallback:fn=>fn,useEffect:()=>{},useState:initial=>{const value=typeof initial==="function"?initial():initial,slot={initial:value,value};slots.push(slot);return [value,next=>{slot.value=typeof next==="function"?next(slot.value):next;}];}};
 const previous={conversation_id:"current-chat",turns:[{turn_id:"current-turn",text:"current text",response:"current reply",status:"completed"}]};
 const initial={agent:{id:"agent",name:"My agent",urn:"urn:agent:own"},identity:{virtualUrn:"urn:console:own",virtualEd25519PublicKey:null},sync:{status:"ready"},snapshots:{},conversations:[{id:"current-chat",title:"Current"},{id:targetId,title:"Target"}],activeConversationId:"current-chat",activeConversationState:{archived:false,draft:"current draft",readAt:0,scrollTop:null},conversation:previous,hasEarlierTurns:false,submission:null,operations:[],recordStates:[]};
 const response={...initial,activeConversationId:targetId,activeConversationState:{archived:false,deleted,draft:"deleted secret draft",readAt:0,scrollTop:null},conversation:deleted?null:{conversation_id:targetId,turns:[]}};
 const provider={useWorkspace:()=>({cacheAgent:data=>cached.push(data),requestSync:async()=>{},getDraft:()=>undefined,saveDraft:(key,value)=>savedDrafts.push({key,value}),error:""}),workspaceRequest:async(url,init)=>{requests.push({url,body:init?.body?JSON.parse(init.body):null});return request?request(url,init,initial):response;}};
 const {useWorkbench}=load("../../src/components/workbench/use-workbench.ts",{"react":react,"@/lib/control/workbench-client":client,"@/lib/workspace/workspace-client":workspaceClient,"@/components/workspace-provider":provider,"./use-workbench-mutations":{useWorkbenchMutations:()=>({actions:[],ready:true})},"@/lib/product/metadata-queue":queue,"@/lib/product/draft-cache":drafts,"./policy-disclosure":{usePolicyAccess:()=>true}});
 return {workbench:useWorkbench(initial.agent,initial),slots,savedDrafts,requests,previous,cached,initial};
}
test("a target deleted between selection and response cannot replace the current chat with its old draft or transcript",async()=>{
 const f=fixture("deleted-chat");assert.equal(await f.workbench.selectConversation("deleted-chat"),false);
 assert.deepEqual(f.requests.map(item=>item.body),[{action:"select_conversation",conversationId:"deleted-chat"}]);
 assert.equal(f.slots.find(slot=>slot.initial==="current draft").value,"current draft");
 assert.ok(f.slots.filter(slot=>slot.initial==="current-chat").every(slot=>slot.value==="current-chat"));
 assert.equal(f.slots.find(slot=>slot.initial===f.previous).value,f.previous);
 assert.equal(f.savedDrafts.some(item=>item.value.text==="deleted secret draft"),false);
});
test("reopening the current chat after another device deleted it clears it without restoring the deleted draft",async()=>{
 const f=fixture("current-chat");assert.equal(await f.workbench.selectConversation("current-chat"),false);
 assert.equal(f.slots.find(slot=>slot.initial==="current draft").value,"");
 assert.equal(f.slots.find(slot=>slot.initial===f.previous).value,null);
 assert.equal(f.savedDrafts.some(item=>item.value.text==="deleted secret draft"),false);
});
test("a live selected chat still restores its authoritative saved draft",async()=>{
 const f=fixture("live-chat",false);assert.equal(await f.workbench.selectConversation("live-chat"),true);
 assert.equal(f.slots.find(slot=>slot.initial==="current draft").value,"deleted secret draft");
 assert.ok(f.slots.filter(slot=>slot.initial==="current-chat").every(slot=>slot.value==="live-chat"));
});

test("a post-delete refresh supersedes an older poll instead of being skipped or resurrecting its records",async()=>{
 const pending=[];const f=fixture("unused",true,(_url,_init,initial)=>new Promise(resolve=>pending.push({resolve,initial})));
 const poll=f.workbench.refreshSaved(),afterDeletion=f.workbench.refreshSaved();
 assert.equal(pending.length,2,"the mutation refresh must read again even while a pre-mutation poll is pending");
 const deleted={kind:"contact",id:"friend",deleted:true,updatedAt:200};
 pending[1].resolve({...pending[1].initial,recordStates:[deleted]});await afterDeletion;
 pending[0].resolve({...pending[0].initial,recordStates:[]});await poll;
 assert.equal(f.cached.length,1);assert.deepEqual(f.cached[0].recordStates,[deleted]);
});
