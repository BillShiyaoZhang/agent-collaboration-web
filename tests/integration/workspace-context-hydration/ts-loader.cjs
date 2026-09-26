const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
// Fixture extensions keep private test-only Context exports out of Next's
// production TypeScript program; this loader still compiles actual hooks.
module.exports=function(source){
 const options=this.getOptions(),name=this.resourcePath.replaceAll('\\','/');
 if(options.variant==='old'){
  if(name.endsWith('/workbench/policy-disclosure.tsx'))source=fs.readFileSync(path.join(options.baselineDir,'baseline-policy.tsx'),'utf8');
  if(name.endsWith('/workbench/use-workbench.ts'))source=fs.readFileSync(path.join(options.baselineDir,'baseline-workbench.ts'),'utf8');
 }
 if(name.endsWith('/workbench/policy-disclosure.tsx'))source+='\nexport const __testPolicyAccessContext=PolicyAccessContext;';
 if(name.endsWith('/components/workspace-provider.tsx'))source+='\nexport const __testWorkspaceContext=WorkspaceContext;';
 return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
};
