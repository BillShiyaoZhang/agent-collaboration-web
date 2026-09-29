const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");
const contract = require("../../packages/client-contract");

function load(relative, dependencies = {}) {
  const filename = path.resolve(__dirname, relative), loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded.require = name => Object.hasOwn(dependencies, name) ? dependencies[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText, filename);
  return loaded.exports;
}

const input = load("../../src/components/workbench/task-mention-input.tsx", {
  "@/components/ui/button": {}, "@/components/ui/textarea": {},
  "@/lib/shared/utils": { cn: (...parts) => parts.filter(Boolean).join(" ") },
  "@/lib/control/workbench-client": contract,
});
const { controlCallSchema } = load("../../src/lib/control/control-protocol.ts", { "@agent-comm/client-contract": contract });
const call = (method, params) => ({ request_id: "cfcedb64-2014-4b6a-a824-639f99c72573", method, params });

test("@ query follows the caret and selection removes only the typed trigger", () => {
  const text = "先处理另一件事，再看 @会议 后面的文字";
  const caret = text.indexOf(" 后面的");
  const trigger = input.taskMentionTrigger(text, caret);
  assert.deepEqual(trigger, { start: text.indexOf("@"), end: caret, query: "会议" });
  assert.equal(input.removeTaskMentionTrigger(text, trigger), "先处理另一件事，再看  后面的文字");
  assert.equal(input.taskMentionTrigger("邮箱 a@b.example", 10), null);
  assert.equal(input.taskMentionTrigger("请看 @", 4).query, "");
  assert.equal(input.taskMentionSearchQuery(input.taskMentionTrigger(`@${"字".repeat(121)}`, 122)).length, 120);
});

test("structured task mentions accept owner task identifiers and reject ambiguous input", () => {
  const good = call("conversation.send", { text: "继续推进", mentions: [{ kind: "task", task_id: "task-1" }, { kind: "task", task_id: "task-2" }] });
  assert.equal(controlCallSchema.safeParse(good).success, true);
  assert.equal(controlCallSchema.safeParse(call("conversation.send", { text: "普通对话" })).success, true);
  assert.equal(controlCallSchema.safeParse(call("conversation.send", { ...good.params, mentions: [good.params.mentions[0], good.params.mentions[0]] })).success, false);
  assert.equal(controlCallSchema.safeParse(call("conversation.send", { text: "x", mentions: [{ kind: "approval", task_id: "task-1" }] })).success, false);
  assert.equal(controlCallSchema.safeParse(call("conversation.send", { text: "x", mentions: [{ kind: "task", task_id: "bad id" }] })).success, false);
  assert.equal(controlCallSchema.safeParse(call("task.detail", { task_id: "task-1" })).success, true);
  assert.equal(controlCallSchema.safeParse(call("task.list", { query: "x".repeat(120) })).success, true);
  assert.equal(controlCallSchema.safeParse(call("task.list", { query: "x".repeat(121) })).success, false);
  assert.equal(controlCallSchema.safeParse(call("task.events", { task_id: "task-1", cursor: "next", limit: 20 })).success, true);
  assert.equal(controlCallSchema.safeParse(call("task.events", { task_id: "task-1", limit: 21 })).success, false);
});
