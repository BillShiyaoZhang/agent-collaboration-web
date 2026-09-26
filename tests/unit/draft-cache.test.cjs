const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),ts=require("typescript");
const filename=path.resolve(__dirname,"../../src/lib/product/draft-cache.ts"),m=new Module(filename,module);
m._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const {chooseDraft,editDraft,acknowledgeDraft}=m.exports;
test("another device's draft wins over saved local text on selection and remount",()=>{
 const edited=editDraft(undefined,"device A V1"),saved=acknowledgeDraft(edited,edited);
 assert.equal(saved.dirty,false);
 assert.equal(chooseDraft("device B V2",saved).text,"device B V2");
 assert.equal(chooseDraft("device B V2",{text:"legacy unversioned V1"}).text,"device B V2");
});
test("only an explicitly unsaved local edit overrides server state before debounce or after a failed save",()=>{
 const edited=editDraft(undefined,"unsaved before navigation");
 assert.equal(chooseDraft("saved server",edited),edited);
 assert.equal(chooseDraft("saved server",acknowledgeDraft(edited,edited)).text,"saved server");
});
test("late acknowledgements cannot clear later edits or a cleared sending draft",()=>{
 const a=editDraft(undefined,"first"),b=editDraft(a,"second");
 assert.equal(acknowledgeDraft(b,a),b);assert.equal(b.dirty,true);
 const cleared=editDraft(b,""),typedAgain=editDraft(cleared,"second");
 assert.equal(acknowledgeDraft(typedAgain,cleared),typedAgain);
 assert.equal(acknowledgeDraft(typedAgain,b),typedAgain);
 assert.equal(acknowledgeDraft(typedAgain,typedAgain).dirty,false);
});

test("a read that crosses an edit or successful save cannot restore old server text",()=>{
 const {draftReadCanRestore}=m.exports;
 assert.equal(draftReadCanRestore({epoch:1,dirty:false},{epoch:1,dirty:false}),true);
 assert.equal(draftReadCanRestore({epoch:1,dirty:false},{epoch:2,dirty:false}),false);
 assert.equal(draftReadCanRestore({epoch:1,dirty:true},{epoch:2,dirty:false}),false);
 assert.equal(draftReadCanRestore({epoch:1,dirty:false},{epoch:2,dirty:true}),false);
});
