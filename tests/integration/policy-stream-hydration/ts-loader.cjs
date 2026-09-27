const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
module.exports=function(source){
 const options=this.getOptions(),name=this.resourcePath.replaceAll('\\','/');
 if(options.variant==='old'&&name.endsWith('/workbench/policy-disclosure.tsx'))source=fs.readFileSync(path.join(options.baselineDir,'baseline-policy.tsx'),'utf8');
 return ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
};
