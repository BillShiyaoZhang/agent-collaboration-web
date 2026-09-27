const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),test=require('node:test'),ts=require('typescript');
const filename=path.resolve(__dirname,'../../src/lib/moderation/native-review-preview.ts'),m=new Module(filename,module);
m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,filename);
const {nativeReviewCandidates:candidates,websiteReviewPreview:preview,matchingNativeReview:match}=m.exports;
const remote={message_id:'exact-message',sender_urn:'urn:agent:peer',kind:'chat.message',text:'完整原正文',fingerprint:'a'.repeat(64),status:'pending',text_truncated:false};
const item=(n,status='pending')=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,agentId:'agent',target:{kind:'inbox',id:remote.message_id},digest:String(n).padStart(64,'0'),status});
const full=(selected,body={message_id:remote.message_id,sender_urn:remote.sender_urn,kind:remote.kind,text:remote.text})=>({item:selected,body,previewToken:'bound-token'});
test('newer placeholder cannot replace an older exact full native body',()=>{
 const newer=item(1),older=item(2),queue=[newer,older],checked=candidates(queue,remote,remote.message_id,'agent');
 const previews=checked.map(selected=>preview(selected,full(selected,{...full(selected).body,text:selected.id===newer.id?'对端内容尚未审核，请在网站核对后再允许展示。':remote.text})));
 assert.equal(match(previews,remote).item.id,older.id);
});
test('same target ID in a different kind is not a native inbox candidate',()=>{
 const wrong={...item(1),target:{kind:'collaboration',id:remote.message_id}};
 assert.deepEqual(candidates([wrong,item(2)],remote,remote.message_id,'agent').map(row=>row.id),[item(2).id]);
});
test('exact rejected body takes priority over pending and approved matches',()=>{
 const rows=[item(1,'approved'),item(2),item(3,'rejected')];
 assert.equal(match(rows.map(row=>preview(row,full(row))),remote).item.id,rows[2].id);
 const historical=full(rows[2]);delete historical.body.kind;
 assert.equal(match([preview(rows[1],full(rows[1])),preview(rows[2],historical)],remote).item.id,rows[2].id,'SDK gives an omitted wire kind the exact chat.message default');
 historical.body.kind=null;assert.equal(match([preview(rows[2],historical)],remote),undefined,'present malformed kind is not a default');
});
test('only placeholders, wrong sender, wrong message, present undefined kind or altered text have no match',()=>{
 for(const body of [{...full(item(1)).body,text:'placeholder'},{...full(item(1)).body,sender_urn:'urn:agent:other'},
  {...full(item(1)).body,message_id:'other-message'},{...full(item(1)).body,kind:undefined},{...full(item(1)).body,text:remote.text+' changed'}]){
  assert.equal(match([preview(item(1),full(item(1),body))],remote),undefined);
 }
});
test('website response must bind exact item, digest, target, owner and a real preview token',()=>{
 const selected=item(1);
 for(const change of [{id:item(2).id},{digest:'f'.repeat(64)},{agentId:'other'},
  {target:{kind:'collaboration',id:remote.message_id}},{target:{kind:'inbox',id:'other'}},{status:'unknown'}]){
  assert.throws(()=>preview(selected,{...full(selected),item:{...selected,...change}}));
 }
 for(const change of [{previewToken:''},{body:null},{body:[]}])assert.throws(()=>preview(selected,{...full(selected),...change}));
 const rejected=item(1,'rejected');assert.throws(()=>preview(rejected,{...full(rejected),item:{...rejected,status:'approved'}}));
});
test('candidate cap fails closed before five or more preview requests',()=>{
 assert.equal(candidates([1,2,3,4].map(n=>item(n)),remote,remote.message_id,'agent').length,4);
 assert.throws(()=>candidates([1,2,3,4,5].map(n=>item(n)),remote,remote.message_id,'agent'));
 assert.throws(()=>candidates([item(1),item(1)],remote,remote.message_id,'agent'));
});
test('truncated, malformed or unbound native preflight is never sufficient',()=>{
 for(const change of [{message_id:'other'},{text_truncated:true},{fingerprint:'f'.repeat(63)},{fingerprint:'F'.repeat(64)},
  {sender_urn:'unknown'},{kind:undefined},{status:'complete'},{text:''}])assert.throws(()=>candidates([item(1)],{...remote,...change},remote.message_id,'agent'));
});
test('candidate ownership, digest and status are checked without expanding scope',()=>{
 for(const change of [{agentId:'other'},{digest:'wrong'},{status:'unknown'},{id:'wrong'}])assert.throws(()=>candidates([{...item(1),...change}],remote,remote.message_id,'agent'));
});
