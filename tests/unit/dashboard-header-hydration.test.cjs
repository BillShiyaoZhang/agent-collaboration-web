const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),test=require('node:test'),ts=require('typescript');
const React=require('react'),{renderToStaticMarkup}=require('react-dom/server');
function load(relative,deps={}){
 const filename=path.resolve(__dirname,relative),m=new Module(filename,module);m.filename=filename;m.paths=Module._nodeModulePaths(path.dirname(filename));
 m.require=name=>Object.hasOwn(deps,name)?deps[name]:Module.prototype.require.call(m,name);
 m._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,filename);return m.exports;
}
const localTime=load('../../src/components/local-time.ts');
const Context=React.createContext({page:{unread:0,pending:0},disableSystem:async()=>{}});
const wrapper=({children})=>React.createElement('div',null,children),hidden=()=>null;
function fixture(time=localTime){
 const {DashboardHeader}=load('../../src/components/layout/dashboard-header.tsx',{
  'next/link':{__esModule:true,default:({children,...props})=>React.createElement('a',props,children)},'next/navigation':{usePathname:()=>'/dashboard/chats'},'next-auth/react':{signOut:async()=>{}},
  '@/components/notification-provider':{useNotifications:()=>React.useContext(Context)},'@/components/local-time':time,
  '@/components/ui/button':{Button:({children,...props})=>React.createElement('button',props,children)},
  '@/components/ui/dialog':{Dialog:wrapper,DialogContent:hidden,DialogTrigger:wrapper,DialogDescription:hidden,DialogTitle:hidden},
  '@/components/ui/dropdown-menu':{DropdownMenu:wrapper,DropdownMenuTrigger:wrapper,DropdownMenuContent:hidden,DropdownMenuItem:hidden,DropdownMenuLabel:hidden,DropdownMenuSeparator:hidden},
  './dashboard-sidebar':{DashboardNavigation:hidden},
 });
 return (unread,pending)=>renderToStaticMarkup(React.createElement(Context.Provider,{value:{page:{unread,pending},disableSystem:async()=>{}}},React.createElement(DashboardHeader,{user:{name:'Synthetic'}})));
}
test('a late header hydration keeps the original empty badges after its notification provider refreshed',()=>{
 const render=fixture(),initial=render(0,0);
 assert.equal(render(7,2),initial);assert.match(initial,/提醒中心，0 条未读，0 项待处理/);assert.doesNotMatch(initial,/2 待处理/);
});
test('after hydration the header displays current counts and removes badges when they clear',()=>{
 const render=fixture({...localTime,useHydrated:()=>true});
 assert.match(render(7,2),/提醒中心，7 条未读，2 项待处理/);assert.match(render(7,2),/>7<\/span>/);assert.match(render(7,2),/>2 待处理<\/span>/);
 assert.match(render(107,0),/>99\+<\/span>/);assert.doesNotMatch(render(0,0),/>99\+<\/span>|待处理<\/span>/);
});
