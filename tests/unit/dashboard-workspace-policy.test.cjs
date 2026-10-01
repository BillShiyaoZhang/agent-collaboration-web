const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path"), Module = require("node:module");
const test = require("node:test"), ts = require("typescript"), React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
test("independent workspace pages do not claim RPC policy controls their HTTP/WS channel", () => {
  let pathname = "/dashboard/chats";
  const filename = path.resolve(__dirname, "../../src/components/layout/dashboard-content.tsx");
  const loaded = new Module(filename, module); loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  const deps = {
    "next/navigation": { usePathname: () => pathname },
    "@/app/dashboard/loading": { default: () => React.createElement("span", null, "Loading") },
    "@/components/workbench/policy-disclosure": { PolicyDisclosureGate: ({ children }) => React.createElement("section", { "data-policy": "rpc" }, children) },
  };
  loaded.require = name => Object.hasOwn(deps, name) ? deps[name] : Module.prototype.require.call(loaded, name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText, filename);
  const render = () => renderToStaticMarkup(React.createElement(loaded.exports.DashboardContent, null, React.createElement("div", null, "Content")));
  assert.match(render(), /data-policy="rpc"/);
  pathname = "/dashboard/workspaces";
  const independent = render(); assert.doesNotMatch(independent, /data-policy="rpc"/); assert.match(independent, /Content/);
  pathname = "/dashboard/contacts"; assert.match(render(), /data-policy="rpc"/);
});
