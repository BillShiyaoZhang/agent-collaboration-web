const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),Module=require("node:module"),ts=require("typescript"),React=require("react"),{renderToStaticMarkup}=require("react-dom/server");
const filename=path.resolve(__dirname,"../../src/components/workbench/message-content.tsx"),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
m._compile(ts.transpileModule(fs.readFileSync(filename,"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,filename);
test("model text is escaped and only HTTP(S) links are clickable",()=>{
 const html=renderToStaticMarkup(React.createElement(m.exports.MessageContent,{text:'<img src=x onerror=alert(1)>\n[unsafe](javascript:alert) [safe](https://example.com/a)'}));
 assert.doesNotMatch(html,/<img|href="javascript:/);assert.match(html,/&lt;img/);assert.match(html,/href="https:\/\/example.com\/a"/);assert.match(html,/noopener noreferrer/);
 for(const value of ["javascript:alert(1)","data:text/html,abc","file:///tmp/x","//evil.example"])assert.equal(m.exports.safeMessageHref(value),null);
});
test("replies render useful list, table, code and plain text blocks",()=>{
 const html=renderToStaticMarkup(React.createElement(m.exports.MessageContent,{text:'**结果**\n- 第一步\n- 第二步\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n'+String.fromCharCode(96).repeat(3)+'js\nconsole.log("ok");\n'+String.fromCharCode(96).repeat(3)}));
 assert.match(html,/<strong>结果/);assert.match(html,/<ul/);assert.match(html,/<table/);assert.match(html,/<pre/);assert.match(html,/console.log/);
});