// Actual repository hooks, real production React hydrateRoot, local-only.
// No Next server, production account or PRODUCT_FIXTURE is required. Historical
// hooks are read from the fixed r3 commit; current hooks must hydrate cleanly.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const runtime=require('next/dist/compiled/webpack/webpack');runtime.init();const webpack=runtime.webpack;
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const {execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),harness=path.join(__dirname,'workspace-context-hydration'),evidence=path.join(root,'build/workspace-sync-preview/context-hydration'),out=path.join(evidence,'compiled');fs.mkdirSync(out,{recursive:true});
const variants=process.env.HARNESS_VARIANTS?.split(',')||['old','new'];
assert.ok(variants.length>0&&variants.every(value=>['old','new'].includes(value)));
const baselineRevision='48df62e';
if(variants.includes('old'))for(const [relative,filename] of [['src/components/workbench/policy-disclosure.tsx','baseline-policy.tsx'],['src/components/workbench/use-workbench.ts','baseline-workbench.ts']]){
 const source=execFileSync('git',['-c','safe.directory='+root.replaceAll('\\','/'),'show',baselineRevision+':'+relative],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','pipe']});fs.writeFileSync(path.join(evidence,filename),source);
}
const report={scope:'Actual hooks / synthetic preupdated parent contexts',baselineRevision,startedAt:new Date().toISOString(),cases:[],businessWritesAllowed:0,authCalls:0};let server,browser;
async function build(variant,target){
 const config={mode:'production',target,entry:path.join(harness,target==='web'?'client.tsx.fixture':'server.tsx.fixture'),output:{path:out,filename:variant+'-'+target+'.cjs',...(target==='node'?{library:{type:'commonjs2'}}:{})},resolve:{extensions:['.tsx.fixture','.tsx','.ts','.js','.json'],alias:{'@':path.join(root,'src')}},module:{rules:[{test:/\.tsx?(?:\.fixture)?$/,exclude:/node_modules/,use:{loader:path.join(harness,'ts-loader.cjs'),options:{variant,baselineDir:evidence}}}]},optimization:{minimize:false},plugins:[new webpack.DefinePlugin({'process.env.NODE_ENV':JSON.stringify('production')})],...(target==='node'?{externals:{react:'commonjs react','react-dom/server':'commonjs react-dom/server','react/jsx-runtime':'commonjs react/jsx-runtime'}}:{})};
 await new Promise((resolve,reject)=>{const compiler=webpack(config);compiler.run((error,stats)=>{compiler.close(()=>{});if(error)reject(error);else if(stats.hasErrors())reject(new Error(stats.toString({all:false,errors:true})));else resolve();});});
}
async function main(){
 for(const variant of variants){await build(variant,'node');await build(variant,'web');}
 const modules=Object.fromEntries(variants.map(variant=>[variant,require(path.join(out,variant+'-node.cjs'))]));
 let blockedWrites=0;
 server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://127.0.0.1');if(req.method!=='GET'){blockedWrites++;res.writeHead(409,{'content-type':'application/json'});res.end('{"error":"Harness forbids business writes"}');return;}
  if(url.pathname.endsWith('.cjs')){res.writeHead(200,{'content-type':'text/javascript'});res.end(fs.readFileSync(path.join(out,path.basename(url.pathname))));return;}
  if(url.pathname.startsWith('/api/')){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(url.pathname.endsWith('/operations')?{items:[]}:Object.values(modules)[0].initial));return;}
  const variant=url.searchParams.get('variant'),kind=url.searchParams.get('kind');assert.ok(modules[variant]);assert.ok(['policy','error','combined'].includes(kind));
  res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html><body><div id="root">'+modules[variant].ssr(kind)+'</div><script>window.__kind='+JSON.stringify(kind)+';</script><script src="/'+variant+'-web.cjs"></script></body></html>');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
 for(const variant of variants)for(const kind of ['policy','error','combined']){
  const ssrHTML=modules[variant].ssr(kind),ssr={policyAllowed:ssrHTML.includes('data-policy-allowed'),externalError:ssrHTML.includes('data-external-error')};assert.deepEqual(ssr,{policyAllowed:false,externalError:false});
  const context=await browser.newContext({serviceWorkers:'block'}),page=await context.newPage();page.setDefaultTimeout(15000);const pageErrors=[];page.on('pageerror',e=>pageErrors.push(e.message));
  await context.route('**/*',async route=>{assert.equal(new URL(route.request().url()).origin,base);await route.continue();});
  await page.goto(base+'/?variant='+variant+'&kind='+kind);
  await page.waitForFunction(()=>window.__renderTrace?.length>0);
  if(kind!=='error')await page.locator('[data-policy-allowed]').waitFor();
  if(kind!=='policy')await page.locator('[data-external-error]').waitFor();
  const result={variant,kind,ssr,...await page.evaluate(()=>({trace:window.__renderTrace,recoverable:window.__recoverable})),pageErrors};
  assert.deepEqual(pageErrors,[]);
  if(variant==='old')assert.ok(result.recoverable.some(e=>e.code==='418'),'negative control must produce a real React418');
  else{assert.deepEqual(result.recoverable,[]);assert.deepEqual(result.trace[0],{allowed:false,error:''});}
  if(kind!=='error'){assert.equal(await page.locator('[data-policy-allowed]').isEnabled(),true);await page.locator('#revoke').click();await page.locator('[data-policy-denied]').waitFor();assert.equal(await page.locator('[data-policy-allowed]').count(),0);result.afterRevocation=await page.evaluate(()=>window.__renderTrace.at(-1));assert.equal(result.afterRevocation.allowed,false);result.revocationObserved=true;}
  if(kind!=='policy'){assert.equal(await page.locator('[data-external-error]').textContent(),modules[variant].fixedError);await page.locator('#clear-error').click();await page.locator('[data-external-error]').waitFor({state:'detached'});result.afterErrorCleared=await page.evaluate(()=>window.__renderTrace.at(-1));assert.equal(result.afterErrorCleared.error,'');result.latestErrorClearObserved=true;}
  result.recoverable=await page.evaluate(()=>window.__recoverable);assert.deepEqual(pageErrors,[]);
  if(variant==='new')assert.deepEqual(result.recoverable,[]);else assert.ok(result.recoverable.length===1&&result.recoverable.every(error=>error.code==='418'),'only the exact negative-control hydration mismatch is expected');
  report.cases.push(result);console.log(JSON.stringify(result));await context.close();
 }
 assert.equal(blockedWrites,0);report.blockedWrites=blockedWrites;report.passed=true;
}
main().catch(error=>{report.passed=false;report.failure={name:error.name,message:error.message};console.error(error.stack);process.exitCode=1;}).finally(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(evidence,'results.json'),JSON.stringify(report,null,2));});
