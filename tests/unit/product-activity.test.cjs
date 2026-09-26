const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),ts=require("typescript");
const filename=path.resolve(__dirname,"../../src/lib/product/activity-model.ts"),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m.require=n=>n==="@/lib/control/workbench-client"?{record:v=>v&&typeof v==="object"&&!Array.isArray(v)?v:{},records:v=>Array.isArray(v)?v.filter(x=>x&&typeof x==="object"):[],string:(v,f="")=>typeof v==="string"?v:f}:Module.prototype.require.call(m,n);
m._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const {activityItems,relatedTaskIds}=m.exports;
const workspace=data=>({agent:{id:"own-agent",name:"自己的agent"},snapshots:{"collaboration.state":{time:1000,sourceAt:900,data}},operations:[]});
test("activity uses confirmed closure and preserves the calendar boundary",()=>{
 const items=activityItems(workspace({tasks:[{task_id:"task",status:"active"}],collaboration_v2:{collaborations:[{task_id:"task",collaboration_id:"collab",phase:"closed",closure_reason:"agreement_only_complete",agreement_synced:true,terms:{topic:"讨论"}}]}}));
 assert.equal(items.length,1);assert.equal(items[0].category,"result");assert.match(items[0].summary,/双方.*同步.*未创建日历/);assert.equal(items[0].sourceAt,900);
});
test("uncertain writes remain actionable and no received message claims agreement",()=>{
 const w=workspace({collaboration_v2:{collaborations:[{collaboration_id:"c",phase:"invited",waiting_reason:"peer_join"}]}});
 w.operations=[{call:{request_id:"r",method:"collaboration.execute"},phase:"uncertain",message:"正在核实"}];
 const items=activityItems(w);assert.equal(items[0].needsAction,true);assert.equal(items[0].category,"uncertain");assert.equal(items.find(i=>i.id==="c").category,"waiting");assert.doesNotMatch(items.find(i=>i.id==="c").summary,/已完成|已同意/);
});
test("task links come only from structured host associations, never message text",()=>{
 assert.deepEqual(relatedTaskIds([{text:"task-secret",response:"task-secret"}],"c",{tasks:[{task_id:"task-secret",source_context:{conversation_id:"another"}}]}),[]);
 assert.deepEqual(relatedTaskIds([{related:[{kind:"task",id:"t"}]}],"c",{tasks:[{task_id:"t2",source_context:{conversation_id:"c"}}]}),["t","t2"]);
});
test("incomplete agreement sync evidence never announces completion",()=>{
 const item=activityItems(workspace({collaboration_v2:{collaborations:[{collaboration_id:"c",phase:"closed",closure_reason:"agreement_only_complete",agreement_synced:false}]}}))[0];
 assert.equal(item.category,"waiting");assert.match(item.summary,/等待核对/);assert.doesNotMatch(item.summary,/双方.*已同步/);
});
