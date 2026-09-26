const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), Module = require("node:module"), test = require("node:test"), ts = require("typescript");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
function load(relative, deps = {}, exposePolicyContext = false) {
 const filename = path.resolve(__dirname, relative), m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
 m.require = name => Object.hasOwn(deps, name) ? deps[name] : Module.prototype.require.call(m, name);
 const compiled = ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText;
 // Reach the real private context in the test loader without adding a product API.
 m._compile(compiled + (exposePolicyContext ? "\nexports.testPolicyContext = PolicyAccessContext;" : ""), filename); return m.exports;
}
const client = load("../../src/lib/control/workbench-client.ts"), drafts = load("../../src/lib/product/draft-cache.ts"), queue = load("../../src/lib/product/metadata-queue.ts");
const workspaceClient = load("../../src/lib/workspace/workspace-client.ts", { "@/lib/control/workbench-client": client });
const localTime = load("../../src/components/local-time.ts");
const agent = { id: "agent", name: "Owned", urn: "urn:agent:owned" };
const initial = { agent, identity: { virtualUrn: "urn:console:owned" }, sync: { status: "ready" }, snapshots: { capabilities: { data: { methods: [{ name: "conversation.send", available: true }] } } }, conversations: [], activeConversationId: "", activeConversationState: { archived: false, readAt: 0, draft: "", scrollTop: null }, conversation: null, hasEarlierTurns: false, submission: null, operations: [], recordStates: [] };
function fixture(time = localTime) {
 const policy = load("../../src/components/workbench/policy-disclosure.tsx", { "@/components/ui/button": {}, "@/components/local-time": time }, true);
 const externalWorkspace = React.createContext({ cacheAgent() {}, requestSync: async () => {}, getDraft: () => undefined, saveDraft() {}, error: "" });
 const { useWorkbench } = load("../../src/components/workbench/use-workbench.ts", {
  "@/lib/control/workbench-client": client, "@/lib/workspace/workspace-client": workspaceClient,
  "@/components/workspace-provider": { useWorkspace: () => React.useContext(externalWorkspace), workspaceRequest: async () => initial },
  "./use-workbench-mutations": { useWorkbenchMutations: () => ({ actions: [], ready: false }) },
  "@/lib/product/metadata-queue": queue, "@/lib/product/draft-cache": drafts, "./policy-disclosure": policy, "@/components/local-time": time,
 });
 function PolicyProbe() { return React.createElement("output", null, String(policy.usePolicyAccess())); }
 function WorkbenchProbe() {
  const w = useWorkbench(agent, initial);
  return React.createElement("section", null, React.createElement("button", { disabled: !w.canSend }, "send"), w.cacheError ? React.createElement("p", { role: "status" }, w.cacheError) : null);
 }
 function render(Component, allowed, error = "") {
  return renderToStaticMarkup(React.createElement(policy.testPolicyContext.Provider, { value: allowed }, React.createElement(externalWorkspace.Provider, { value: { cacheAgent() {}, requestSync: async () => {}, getDraft: () => undefined, saveDraft() {}, error } }, React.createElement(Component))));
 }
 return { PolicyProbe, WorkbenchProbe, render };
}
test("real policy SSR keeps the false hydration snapshot even when the outer provider already allowed access", () => {
 const f = fixture();
 assert.equal(f.render(f.PolicyProbe, false), "<output>false</output>");
 assert.equal(f.render(f.PolicyProbe, true), "<output>false</output>", "a late consumer must reproduce the original server policy snapshot");
});
test("real workbench SSR keeps its original empty external error after the provider refreshed", () => {
 const f = fixture();
 const original = f.render(f.WorkbenchProbe, false, "");
 assert.equal(f.render(f.WorkbenchProbe, true, "Connection refresh failed"), original, "external policy/error updates cannot add or remove nodes in a consumer's server hydration pass");
 assert.doesNotMatch(original, /role="status"/);
});
test("a client snapshot uses current policy revocation and preserves the latest real provider error", () => {
 // Only choose the helper's post-hydration snapshot. Context, hooks and SSR renderer are real.
 const f = fixture({ ...localTime, useHydrated: () => true });
 assert.equal(f.render(f.PolicyProbe, true), "<output>true</output>");
 assert.equal(f.render(f.PolicyProbe, false), "<output>false</output>");
 const allowed = f.render(f.WorkbenchProbe, true, "Connection refresh failed");
 assert.match(allowed, /<button>send<\/button>/); assert.match(allowed, /<p role="status">Connection refresh failed<\/p>/);
 const revoked = f.render(f.WorkbenchProbe, false, "Network is offline");
 assert.match(revoked, /<button disabled="">send<\/button>/); assert.match(revoked, /<p role="status">Network is offline<\/p>/);
});
