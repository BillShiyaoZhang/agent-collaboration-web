// Actual ContentReviewPage, Button and WorkbenchClient; loopback synthetic transport only.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..'),fixture=path.join(__dirname,'content-review-version');
const out=path.join(root,'build/workspace-sync-preview/content-review-version');fs.mkdirSync(out,{recursive:true});
const baseline='a919245809b5c37f634459f76b1960296ab0327a';
fs.writeFileSync(path.join(out,'baseline.tsx'),execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'show',baseline+':src/components/content-review-page.tsx'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']}));
const compiled=path.join(root,'node_modules/next/dist/compiled'),runtime=require(path.join(compiled,'webpack/webpack'));runtime.init();
const webpack=runtime.webpack,{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const hash=value=>createHash('sha256').update(value).digest('hex');
const report={baseline,reactVersion:require(path.join(compiled,'react')).version,
 component_sha256:hash(fs.readFileSync(path.join(root,'src/components/content-review-page.tsx'))),
 selector_sha256:hash(fs.readFileSync(path.join(root,'src/lib/moderation/native-review-preview.ts'))),
 scope:'actual component and client, synthetic loopback HTTP; no identities, databases or external business',cases:[],external_requests:0};
const message='exact-synthetic-message',agent='synthetic-agent',sender='urn:agent:synthetic-peer',text='完整浏览器合成正文；仅用于精确网站与本机审核关联，不请求工具或外部动作。';
const placeholder='对端内容尚未审核，请在网站核对后再允许展示。';
const item=(n,status='pending',kind='inbox')=>({id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,agentId:agent,target:{kind,id:message},digest:String(n).padStart(64,'0'),status});
const body=()=>({message_id:message,sender_urn:sender,kind:'chat.message',text});
let server,browser,current;

async function build(variant){
 const config={mode:'production',target:'web',entry:path.join(fixture,'client.tsx.fixture'),output:{path:out,filename:variant+'.js'},
  resolve:{extensions:['.tsx.fixture','.ts.fixture','.tsx','.ts','.js','.json'],modules:[path.join(root,'node_modules'),'node_modules'],alias:{
   '@':path.join(root,'src'),'next/navigation$':path.join(fixture,'navigation.ts.fixture'),'next/link$':path.join(fixture,'link.tsx.fixture'),
   'next-auth/react$':path.join(fixture,'session.ts.fixture'),'react$':path.join(compiled,'react'),'react/jsx-runtime$':path.join(compiled,'react/jsx-runtime.js'),
   'react/jsx-dev-runtime$':path.join(compiled,'react/jsx-dev-runtime.js'),'react-dom$':path.join(compiled,'react-dom'),
   'react-dom/client$':path.join(compiled,'react-dom/client.js'),'scheduler$':path.join(compiled,'scheduler')}},
  module:{rules:[{test:/\.tsx?(?:\.fixture)?$/,exclude:/node_modules/,use:{loader:path.join(fixture,'ts-loader.cjs'),options:{variant,baseline:path.join(out,'baseline.tsx')}}}]},
  optimization:{minimize:false},plugins:[new webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('production')})]};
 await new Promise((resolve,reject)=>{const compiler=webpack(config);compiler.run((error,stats)=>compiler.close(()=>error?reject(error):stats.hasErrors()?reject(new Error(stats.toString({all:false,errors:true}))):resolve()));});
}
function json(res,value,status=200){res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));}
function complete(res,call,result){json(res,{request_id:call.request_id,status:'complete',response:{request_id:call.request_id,method:call.method,result}});}
function setup(name){
 current={name,session:1,events:[],queue:[item(1),item(3,'pending','collaboration'),item(2)],bodies:{1:{...body(),text:placeholder},2:body(),3:body()},nativeStatus:'pending'};
 if(name==='only-placeholder')current.queue=[item(1)];
 if(name==='specific-second'){current.queue=[item(1),item(4),item(2)];current.bodies[4]=body();}
 if(name==='already-native-approved')current.nativeStatus='approved';
 if(name==='wrong-sender')current.bodies[2]={...body(),sender_urn:'urn:agent:other'};
 if(name==='wrong-message')current.bodies[2]={...body(),message_id:'other-message'};
 if(name==='wrong-kind')current.bodies[2]={...body(),kind:'other.message'};
 if(['rejected-match','rejected-match-default-kind'].includes(name)){current.queue=[item(2,'approved'),item(4,'rejected')];current.bodies[4]=body();if(name==='rejected-match-default-kind')delete current.bodies[4].kind;}
 if(name==='specific-rejected-conflict'){current.queue=[item(2,'approved'),item(4,'rejected')];current.bodies[4]=body();}
 if(name==='too-many'){current.queue=[1,2,3,4,5].map(n=>item(n));for(let n=1;n<=5;n++)current.bodies[n]=body();}
 return current;
}
function handle(req,res){
 const url=new URL(req.url,'http://127.0.0.1');
 if(req.method==='GET'&&url.pathname==='/'){res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end('<!doctype html><meta charset="utf-8"><div id="root"></div><script src="/'+url.searchParams.get('variant')+'.js"></script>');return;}
 if(['/old.js','/new.js'].includes(url.pathname)){res.writeHead(200,{'content-type':'text/javascript'});res.end(fs.readFileSync(path.join(out,path.basename(url.pathname))));return;}
 if(url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
 if(url.pathname==='/api/auth/session'){json(res,{user:{id:'synthetic-owner',sessionVersion:current.session,loginSessionId:'login-'+current.session}});return;}
 if(url.pathname===`/api/agents/${agent}/workspace`){json(res,{snapshots:{capabilities:{data:{methods:[
   {name:'inbox.review_preview',available:current.name!=='no-native-capability'},{name:'inbox.review',available:current.name!=='no-write-capability'}]}},
   'inbox.list':{data:{pending_review:[{message_id:message,sender_urn:sender}]}}}});return;}
 if(url.pathname==='/api/moderation/content'&&req.method==='GET'){json(res,{items:current.queue});return;}
 if(req.method==='POST'&&[ `/api/agents/${agent}/control`,'/api/moderation/content'].includes(url.pathname)){
  let data='';req.on('data',chunk=>data+=chunk);req.on('end',()=>{try{
   const call=JSON.parse(data);current.events.push({path:url.pathname,method:call.method,action:call.action,id:call.id,digest:call.digest,params:call.params,consent:call.consent});
   if(call.method==='inbox.review_preview'){
    assert.deepEqual(call.params,{message_id:message});const native={...body(),fingerprint:'a'.repeat(64),text_truncated:current.name==='truncated-native',status:current.nativeStatus};
    if(current.name==='malformed-native')native.fingerprint='BAD';
    const deliver=()=>complete(res,call,native);
    if(current.name==='busy')current.held=deliver;else deliver();return;
   }
   if(call.method==='inbox.review'){
    assert.deepEqual(call.params,{message_id:message,decision:'approve'});assert.equal(current.nativeStatus,'pending');
    current.nativeStatus='approved';const deliver=()=>complete(res,call,{message_id:message,sender_urn:sender,status:'approved',fingerprint:'a'.repeat(64)});
    if(['blur-during-native-decision','scope-during-native-decision'].includes(current.name))current.held=deliver;else deliver();return;
   }
   if(call.action==='preview'){
    const selected=current.queue.find(row=>row.id===call.id);assert.ok(selected);
    const n=Number(selected.id.slice(-12)),value={item:{...selected},body:current.bodies[n],previewToken:'bound-'+selected.id};
    if(current.name==='wrong-digest'&&n===2)value.item.digest='f'.repeat(64);
    if(current.name==='wrong-target'&&n===2)value.item.target={kind:'inbox',id:'other-message'};
    if(current.name==='wrong-item'&&n===2)value.item.id=item(99).id;
    const deliver=()=>json(res,value);
    if(['scope-changed','blur-during-preview'].includes(current.name)&&!current.heldOnce){current.heldOnce=true;current.held=deliver;}else deliver();return;
   }
   if(call.action==='decide'){
    assert.equal(call.id,item(2).id);assert.equal(call.digest,item(2).digest);assert.equal(call.previewToken,'bound-'+item(2).id);
    assert.equal(call.consent,true);assert.equal(call.decision,'approve');assert.equal(current.nativeStatus,'approved','native decision must precede website decision');
    const selected=current.queue.find(row=>row.id===call.id);selected.status='approved';json(res,{item:selected});return;
   }
   throw new Error('Unexpected synthetic method');
  }catch(error){report.server_failure=error.message;json(res,{error:'synthetic server assertion'},500);}});return;
 }
 res.writeHead(404);res.end();
}
const previewCount=s=>s.events.filter(row=>row.action==='preview').length;
const nativeWrites=s=>s.events.filter(row=>row.method==='inbox.review').length;
const webWrites=s=>s.events.filter(row=>row.action==='decide').length;
async function held(page,s){for(let n=0;!s.held&&n<100;n++)await page.waitForTimeout(10);assert.ok(s.held);}
async function runCase(base,variant,name){
 const s=setup(name),context=await browser.newContext(),page=await context.newPage(),errors=[];page.setDefaultTimeout(5000);
 await page.route('**/*',route=>{if(!route.request().url().startsWith(base+'/')){report.external_requests++;return route.abort();}return route.continue();});
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await page.goto(base+`/?variant=${variant}&agentId=${agent}&messageId=${message}`);
  const launch=name.startsWith('specific-')?page.getByRole('button',{name:'我理解风险，查看这份内容',exact:true}).nth(name==='specific-second'?2:0):page.getByRole('button',{name:'我理解风险，查看完整待审核内容',exact:true});await launch.waitFor();
  await launch.click();
  if(name==='busy'){
   await held(page,s);assert.equal(await launch.isDisabled(),true);await launch.evaluate(element=>element.dispatchEvent(new MouseEvent('click',{bubbles:true})));
   assert.equal(s.events.filter(row=>row.method==='inbox.review_preview').length,1);s.held();s.held=undefined;
  }
  if(['scope-changed','blur-during-preview'].includes(name)){
   await held(page,s);if(name==='scope-changed')s.session=2;else await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
   s.held();s.held=undefined;
  }
  const positive=['positive','busy','already-native-approved','specific-second','rejected-match','rejected-match-default-kind','blur-after-preview','no-write-capability','blur-during-native-decision','scope-during-native-decision'].includes(name)&&variant==='new';
  if(positive){
   await page.getByRole('heading',{name:'完整证据预览',exact:true}).waitFor();
   const shown=JSON.parse(await page.locator('pre').textContent()),expected=body();if(name==='rejected-match-default-kind')delete expected.kind;assert.deepEqual(shown,expected);
   const approve=page.getByRole('button',{name:'内容合适，允许 App 展示',exact:true});assert.equal(await approve.isDisabled(),true);
   assert.equal(nativeWrites(s),0);assert.equal(webWrites(s),0);
   if(name==='blur-after-preview'){
    await page.evaluate(()=>window.dispatchEvent(new Event('blur')));await page.getByRole('heading',{name:'完整证据预览',exact:true}).waitFor({state:'hidden'});
   }else{
    await page.getByRole('checkbox').check();
    if(['rejected-match','rejected-match-default-kind'].includes(name))assert.equal(await approve.isDisabled(),true);
    else if(name==='no-write-capability'){await approve.click();await page.getByRole('alert').waitFor();}
    else if(['blur-during-native-decision','scope-during-native-decision'].includes(name)){
     await approve.click();await held(page,s);
     if(name==='scope-during-native-decision')s.session=2;else await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
     s.held();s.held=undefined;await page.getByRole('alert').waitFor();assert.equal(webWrites(s),0);
    }
    else{
     await approve.click();await page.getByText('已允许网页展示',{exact:false}).first().waitFor();
     assert.equal(nativeWrites(s),name==='already-native-approved'?0:1);assert.equal(webWrites(s),1);
     const writes=s.events.filter(row=>row.method==='inbox.review'||row.action==='decide');
     if(name==='already-native-approved')assert.equal(writes[0].action,'decide');else{assert.equal(writes[0].method,'inbox.review');assert.equal(writes[1].action,'decide');}
    }
   }
  }else{
   await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('heading',{name:'完整证据预览',exact:true}).count(),0);
  }
  const completes=['positive','busy','already-native-approved','specific-second'].includes(name)&&variant==='new';
  assert.equal(nativeWrites(s),completes&&name!=='already-native-approved'||['blur-during-native-decision','scope-during-native-decision'].includes(name)?1:0);assert.equal(webWrites(s),completes?1:0);
  assert.ok(previewCount(s)<=4);assert.ok(!s.events.some(row=>row.action==='preview'&&row.id===item(3,'pending','collaboration').id));
  if(['too-many','no-native-capability','truncated-native','malformed-native'].includes(name))assert.equal(previewCount(s),0);
  assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>window.__reactVersion),report.reactVersion);
  report.cases.push({variant,name,website_previews:previewCount(s),native_writes:nativeWrites(s),website_decides:webWrites(s),errors,passed:true});
 }finally{if(s.held)s.held();await context.close();}
}
async function main(){
 await build('old');await build('new');server=http.createServer(handle);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;assert.ok(![3061,3062,3063].includes(port));report.port=port;
 browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
 const base=`http://127.0.0.1:${port}`;await runCase(base,'old','positive');
 for(const name of ['positive','busy','already-native-approved','specific-second','specific-placeholder','specific-rejected-conflict','only-placeholder','wrong-sender','wrong-message','wrong-kind','wrong-digest','wrong-target','wrong-item',
  'rejected-match','rejected-match-default-kind','too-many','no-native-capability','no-write-capability','truncated-native','malformed-native','scope-changed','blur-during-preview','blur-after-preview',
  'blur-during-native-decision','scope-during-native-decision'])await runCase(base,'new',name);
 assert.equal(report.server_failure,undefined);assert.equal(report.external_requests,0);report.passed=true;
 console.log('PASS_CONTENT_REVIEW_VERSION '+report.cases.length+' cases');
}
main().catch(error=>{report.failure=error.message;console.error(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(report,null,2));});
