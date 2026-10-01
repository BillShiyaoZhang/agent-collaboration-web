export type WorkspaceNode = {
  node_id: string;
  name: string;
  status: "pending" | "claimed" | "paired" | "revoked" | "expired";
  online: boolean;
  account_id: string | null;
  account_label: string | null;
  grant_id: string | null;
  scopes: ("workspace.control" | "workspace.manage")[];
  expires_at: string;
  workspace_origin: string;
  last_seen_at: string | null;
};

type NodeState = Pick<WorkspaceNode, "status" | "online" | "expires_at">;
export function workspaceNodeStatus(node: NodeState): string {
  if (node.status === "revoked") return "已撤销";
  if (node.status === "expired" || Date.parse(node.expires_at) <= Date.now()) return "授权已到期";
  if (node.status === "claimed") return "等待本机确认";
  if (node.status === "pending") return "等待领取";
  return node.online ? "在线" : "离线";
}

export function canOpenWorkspaceNode(node: NodeState): boolean {
  return node.status === "paired" && node.online && Date.parse(node.expires_at) > Date.now();
}

export const workspaceScopeLabels = {
  "workspace.control": "操作工作区与运行任务",
  "workspace.manage": "管理模型、Agent 与能力配置",
};

// Long histories remain traversable while the browser retains a bounded window.
export function mergeWorkspaceNodePage(previous: WorkspaceNode[], page: WorkspaceNode[]): WorkspaceNode[] {
  return [...new Map([...previous, ...page].map(node => [node.node_id, node])).values()].slice(-500);
}
