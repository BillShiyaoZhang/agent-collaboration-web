const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const test = require("node:test");
const ts = require("typescript");
const filename = path.resolve(__dirname, "../../src/lib/workspace/workspace-mutation-policy.ts");
const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, filename);
const { canRestartMutation } = loaded.exports;
const call = (method, params) => ({ request_id: "original-id", method, params });

test("unknown contact additions and arbitrary collaboration effects cannot receive a new transport ID", () => {
  assert.equal(canRestartMutation(call("contacts.add", { contact_id: "friend", aliases: ["name"], urn: "urn:agent:friend" })), false);
  assert.equal(canRestartMutation(call("collaboration.execute", { action: "invite", task_id: "task" })), false);
  assert.equal(canRestartMutation(call("collaboration.execute", { action: "pause_worker", task_id: "task" })), false);
});
test("legacy message sends without their exact stable message ID cannot be restarted", () => {
  const params = { recipient_urn: "urn:agent:friend", text: "message" };
  assert.equal(canRestartMutation(call("messages.send", params)), false);
  assert.equal(canRestartMutation(call("messages.send", { ...params, message_id: "" })), false);
  assert.equal(canRestartMutation(call("messages.send", { ...params, message_id: "bad id" })), false);
  assert.equal(canRestartMutation(call("messages.send", { ...params, message_id: "stable-message" })), true);
});
test("only exact stable approval/request/message objects support explicit recheck", () => {
  for (const [method, params] of [
    ["approval.respond", { approval_id: "approval-version", decision: "approve" }],
    ["approval.respond", { approval_id: "approval-version", decision: "deny" }],
    ["contacts.respond", { request_id: "friend-request", decision: "accept" }],
    ["contacts.respond", { request_id: "friend-request", decision: "reject" }],
    ["inbox.mark_read", { message_id: "message" }],
  ]) assert.equal(canRestartMutation(call(method, params)), true);
  for (const [method, params] of [
    ["approval.respond", { decision: "approve" }],
    ["approval.respond", { approval_id: "approval", decision: "replace" }],
    ["contacts.respond", { request_id: "bad request", decision: "accept" }],
    ["inbox.mark_read", {}],
    ["conversation.send", { text: "same message" }],
  ]) assert.equal(canRestartMutation(call(method, params)), false);
});

test("completed contact feedback stays dismissed across polls while unknown actions and account audit data remain intact",()=>{
 const {presentedMutationActions}=loaded.exports;
 const complete={call:{request_id:"completed",method:"contacts.add"},phase:"succeeded"};
 const failed={call:{request_id:"failed",method:"contacts.add"},phase:"failed"};
 const unknown={call:{request_id:"unknown",method:"contacts.add"},phase:"uncertain"};
 const execute={call:{request_id:"execute",method:"collaboration.execute"},phase:"uncertain"};
 const saved=[complete,failed,unknown,execute],dismissed=new Set(saved.map(item=>item.call.request_id));
 assert.deepEqual(presentedMutationActions(saved,dismissed),[unknown,execute]);
 assert.deepEqual(presentedMutationActions(saved,dismissed),[unknown,execute],"later server poll cannot resurrect completed contact feedback");
 assert.equal(saved.length,4,"presentation never mutates saved account audit input");
 assert.deepEqual(presentedMutationActions([{...complete,phase:"uncertain"}],dismissed).map(item=>item.phase),["uncertain"],"new authenticated uncertainty is never hidden");
});
