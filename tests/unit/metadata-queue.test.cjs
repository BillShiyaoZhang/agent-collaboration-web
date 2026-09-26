const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),ts=require("typescript");
const filename=path.resolve(__dirname,"../../src/lib/product/metadata-queue.ts"),m=new Module(filename,module);
m._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
test("same conversation writes finish in editing order and switching flushes the last draft",async()=>{
 const enqueue=m.exports.createMetadataQueue(),seen=[];let release;
 const slow=enqueue("topic",()=>new Promise(r=>{release=()=>{seen.push("A");r("A");};}));
 const fast=enqueue("topic",async()=>{seen.push("B");return "B";});
 const flush=enqueue("topic",async()=>{seen.push("latest");return "latest";});
 await Promise.resolve();await Promise.resolve();assert.deepEqual(seen,[]);release();await Promise.all([slow,fast,flush]);assert.deepEqual(seen,["A","B","latest"]);
});
test("one failed metadata save cannot block later drafts or another conversation",async()=>{
 const enqueue=m.exports.createMetadataQueue();const failed=enqueue("a",async()=>{throw Error("network");});
 const caught=assert.rejects(failed,/network/);assert.equal(await enqueue("b",async()=>"other"),"other");assert.equal(await enqueue("a",async()=>"recovered"),"recovered");await caught;
});