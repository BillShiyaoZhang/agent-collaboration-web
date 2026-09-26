const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), Module = require("node:module"), test = require("node:test"), ts = require("typescript");
const React = require("react"), { renderToStaticMarkup } = require("react-dom/server");
function load(relative, deps = {}) {
 const filename = path.resolve(__dirname, relative), m = new Module(filename, module); m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
 m.require = name => Object.hasOwn(deps, name) ? deps[name] : Module.prototype.require.call(m, name);
 m._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename); return m.exports;
}
const client = load("../../src/lib/control/workbench-client.ts");
const common = {
 "next/link": { default: ({ children, ...props }) => React.createElement("a", props, children), __esModule: true },
 "next/navigation": { useRouter: () => ({ push() {}, replace() {} }), useSearchParams: () => new URLSearchParams() },
 "@/lib/shared/utils": { cn: (...values) => values.filter(Boolean).join(" ") },
 "@/components/ui/button": load("../../src/components/ui/button.tsx", { "@/lib/shared/utils": { cn: (...values) => values.filter(Boolean).join(" ") } }),
 "@/components/ui/input": load("../../src/components/ui/input.tsx", { "@/lib/shared/utils": { cn: (...values) => values.filter(Boolean).join(" ") } }),
 "@/components/ui/textarea": load("../../src/components/ui/textarea.tsx", { "@/lib/shared/utils": { cn: (...values) => values.filter(Boolean).join(" ") } }),
 "@/components/local-time": { useLocalTime: () => () => "time" },
 "@/components/workspace-provider": { workspaceRequest: () => new Promise(() => {}) },
 "@/lib/control/workbench-client": client,
};
const passthrough = ({ children }) => children;
const dialog = { Dialog: ({ open, children }) => open ? children : null, DialogContent: passthrough, DialogHeader: passthrough, DialogFooter: passthrough, DialogTitle: passthrough, DialogDescription: passthrough };
const menu = Object.fromEntries(["DropdownMenu", "DropdownMenuContent", "DropdownMenuItem", "DropdownMenuSeparator", "DropdownMenuTrigger"].map(name => [name, passthrough]));
const library = load("../../src/components/workbench/conversation-library.tsx", { ...common, "@/components/ui/dialog": dialog, "@/components/ui/dropdown-menu": menu });
const panel = load("../../src/components/workbench/conversation-panel.tsx", {
 ...common, "@/components/ui/dialog": dialog, "./conversation-library": library,
 "./snapshot-views": { CopyValue: () => null, RawSnapshot: () => null, StatusBadge: () => null },
 "./pairing-panel": { RequestFeedback: () => null }, "./message-content": { MessageContent: () => null },
 "./collaboration-snapshot": { CollaborationOverview: () => null }, "./mutation-panels": { ApprovalRequests: () => null },
 "./collaboration-workflow-model": { collaborationOperations: () => [] }, "@/lib/product/activity-model": { relatedTaskIds: () => [] },
});
const agent = { id: "own-agent", name: "Own", urn: "urn:agent:own" };
const workspace = { agent, snapshots: {}, sync: { status: "ready" }, activeConversationId: "", conversations: [], recordStates: [] };
const initial = { agents: [{ workspace, items: [] }] };
const workbench = {
 agentId: agent.id, snapshots: {}, sync: workspace.sync, turns: [], conversations: [], operations: [], recordStates: [], conversationId: "", conversationInput: "", conversationState: { scrollTop: null },
 text: "", composer: { current: null }, busy: {}, errors: {}, canSend: true, canReadConversation: true, currentSnapshot: null, selectingConversation: false,
 setText() {}, saveConversationState() {}, newConversation() {}, readConversation() {}, sendMessage() {},
};
function hub(react = React) {
 return load("../../src/components/workspace-hub.tsx", { ...common, react,
 "@/components/remote-workbench": { RemoteWorkbench: () => React.createElement("button", null, "Scoped action") },
 "@/components/workbench/record-actions": { isRecordDeleted: () => false, recordDeletionReason: () => undefined, RecordActions: () => null, DeletedRecordsPanel: () => null },
 }).WorkspaceHub;
}
function guardedMarkup(Component, props) {
 const html = renderToStaticMarkup(React.createElement(Component, props));
 assert.match(html, /^<fieldset[^>]*disabled=""[^>]*inert=""[^>]*class="contents">/, "SSR must disable native controls and make all descendants inert before their handlers exist");
 assert.match(html, /<\/div><\/fieldset>$/, "the existing layout root must remain inside the complete guard");
 return html;
}
test("My agents SSR protects the real library search, native composer, agent selectors and links", () => {
 const { MyAgentsWorkspace } = load("../../src/components/my-agents-workspace.tsx", { ...common,
 "@/components/workbench/conversation-panel": panel, "@/components/workbench/conversation-library": library,
 "@/components/workbench/agent-connection-menu": { AgentConnectionMenu: () => React.createElement("button", null, "Manage agent") },
 "@/components/workbench/use-workbench": { useWorkbench: () => workbench }, "@/lib/workspace/workspace-client": { syncLabel: () => "Ready" },
 });
 const html = guardedMarkup(MyAgentsWorkspace, { initial });
 assert.match(html, /<input[^>]*aria-label="搜索已保存对话"/);
 assert.match(html, /<textarea[^>]*aria-label="给 agent 的消息"/);
 assert.match(html, /<button[^>]*aria-label="与 Own 聊天"/);
 assert.match(html, /href="\/dashboard\/agents"/);
 assert.match(html, /data-my-agents-workspace="true"/, "the flex layout root is retained");
});
test("Cooperation and contact SSR protect local filters and searches as well as scoped controls", () => {
 const WorkspaceHub = hub();
 const aggregate = guardedMarkup(WorkspaceHub, { initial, mode: "collaborations" });
 assert.match(aggregate, /<input[^>]*aria-label="搜索合作"/);
 assert.match(aggregate, /aria-pressed="false"[^>]*>需我处理<\/button>/);
 assert.match(aggregate, /<select[^>]*aria-label="合作所属 agent"/);
 assert.match(aggregate, />发起合作<\/button>/);
 const contacts = guardedMarkup(WorkspaceHub, { initial, mode: "contacts" });
 assert.match(contacts, /<select[^>]*aria-label="联系人所属 agent"/);
 assert.match(contacts, /Scoped action/);
});
