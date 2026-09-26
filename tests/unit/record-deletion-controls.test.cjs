const assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),test=require("node:test"),ts=require("typescript");
function load(relative,deps={}) {const filename=path.resolve(__dirname,relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));m.require=name=>Object.hasOwn(deps,name)?deps[name]:Module.prototype.require.call(m,name);m._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,filename);return m.exports;}
const client=load("../../src/lib/control/workbench-client.ts");
const {recordDeletionReason,isRecordDeleted}=load("../../src/components/workbench/record-actions.tsx",{"@/lib/control/workbench-client":client,"@/components/ui/button":{},"@/components/ui/dialog":{},"@/components/workspace-provider":{},"@/components/local-time":{}});
const source=(data,changes={})=>({snapshots:{"collaboration.state":{data}},operations:[],submission:null,...changes});
const ended={task_id:"task",collaboration_id:"first-collab",phase:"closed",closure_reason:"agreement_only_complete",agreement_synced:true};
test("delete controls consider every collaboration on a shared task and require real synchronization",()=>{
 const state={tasks:[{task_id:"task",status:"active"}],collaboration_v2:{collaborations:[ended,{...ended,collaboration_id:"second-collab",phase:"negotiating"}]}};
 assert.match(recordDeletionReason(source(state),"collaboration","first-collab"),/仍在进行/);
 state.collaboration_v2.collaborations[1].phase="closed";
 assert.equal(recordDeletionReason(source(state),"collaboration","first-collab"),undefined);
 state.collaboration_v2.collaborations[1].agreement_synced=false;
 assert.match(recordDeletionReason(source(state),"collaboration","task"),/结果待核实/);
 const tombstone=[{kind:"collaboration",id:"task",relatedIds:["task","first-collab","second-collab"],deleted:true,updatedAt:1}];
 assert.equal(isRecordDeleted(tombstone,"collaboration","second-collab"),true);
 assert.equal(isRecordDeleted(tombstone,"contact","second-collab"),false);
});
test("expired presentation leases and operation-linked approvals remain visible before deleting their records",()=>{
 const task={tasks:[{task_id:"task",status:"active"}],collaborations:[ended],operations:[{operation_id:"invite-op",task_id:"task",collaboration_id:"first-collab"}],pending_confirmations:[{approval_id:"approval",subject_id:"invite-op",status:"expired"}]};
 assert.match(recordDeletionReason(source(task),"collaboration","task"),/待确认/);
 task.pending_confirmations[0].status="approved";
 assert.equal(recordDeletionReason(source(task),"collaboration","task"),undefined);
 const contacts={contacts:[{contact_id:"friend",aliases:["Friend"],urn:"urn:agent:friend",connection_status:"connected"}],pending_confirmations:[{approval_id:"approval",target:{id:"urn:agent:friend"},status:"expired"}]};
 assert.match(recordDeletionReason(source(contacts),"contact","friend"),/待确认/);
 contacts.pending_confirmations=[];
 assert.match(recordDeletionReason(source(contacts,{snapshots:{"collaboration.state":{data:contacts},"contacts.requests":{data:{requests:[{peer_urn:"urn:agent:friend",status:"pending"}]}}}}),"contact","friend"),/好友申请/);
});
