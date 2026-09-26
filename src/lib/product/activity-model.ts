import { record, records, string, type RemoteRecord } from "@/lib/control/workbench-client";
import type { WorkspaceAgent } from "@/lib/workspace/workspace-types";

export type ActivityItem = { id: string; agentId: string; agentName: string; title: string; summary: string; href: string;
  updatedAt: number; category: "decision" | "working" | "waiting" | "result" | "uncertain"; needsAction: boolean; sourceAt: number };
export type AgentActivity = { workspace: WorkspaceAgent; items: ActivityItem[] };
const waiting: Record<string, string> = { owner_decision: "等待你的决定", peer_join: "等待对方加入", peer_accept: "等待对方接受当前方案",
  agreement_sync: "等待对方核对约定", agreement_ack: "等待约定同步回执", agreement_ack_delivery: "同步回执正在投递", missing_event: "正在核对缺失事件",
  maintenance_permission: "后续同步权限需要你决定", maintenance_budget: "后续同步预算已用尽", event_chain_conflict: "双方记录需要核实", withdrawal_decision: "撤回结果需要核实", cancel_decision: "等待取消决定" };
const phases: Record<string, string> = { invited: "等待对方加入", negotiating: "正在协调当前方案", partially_accepted: "一方已接受，等待另一方", agreed: "约定已形成，等待同步", reconciling: "正在核对双方记录" };
const ended: Record<string, string> = { agreement_only_complete: "双方会议约定已同步 · 未创建日历", cancelled: "约定取消已确认", withdrawn: "接受撤回已确认", expired: "本轮已结束：已到期" };
export function activityItems(workspace: WorkspaceAgent): ActivityItem[] {
  const snapshot = workspace.snapshots["collaboration.state"], data = record(snapshot?.data), view = Array.isArray(data.collaborations) ? data : record(data.collaboration ?? data.collaboration_v2);
  const base = `/dashboard/agents/${encodeURIComponent(workspace.agent.id)}`;
  const item = (id: string, title: string, summary: string, category: ActivityItem["category"], needsAction: boolean, target = id): ActivityItem => ({
    id, agentId: workspace.agent.id, agentName: workspace.agent.name, title, summary, category, needsAction,
    href: `${base}?tab=tasks&subject=${encodeURIComponent(target)}`, updatedAt: snapshot?.sourceAt || snapshot?.time || 0, sourceAt: snapshot?.sourceAt || snapshot?.time || 0,
  });
  const approvals = records(data.pending_confirmations ?? data.approvals).filter(value => ["pending", "presenting", "expired"].includes(string(value.status)));
  const result = approvals.map(value => item(string(value.approval_id), "需要你决定", string(value.question, "请打开当前问题核对范围和后果。"), "decision", true));
  for (const value of records(view.collaborations)) {
    const id = string(value.collaboration_id), taskId = string(value.task_id, id), reason = string(value.waiting_reason), closure = string(value.closure_reason);
    const needsAction = ["owner_decision", "maintenance_permission", "maintenance_budget", "event_chain_conflict", "withdrawal_decision"].includes(reason) || reason==="cancel_decision" && record(value.cancel_request).sender_urn===value.peer_urn;
    const confirmedClosure=string(value.phase)==="closed" && !!ended[closure] && (closure!=="agreement_only_complete" || value.agreement_synced===true);
    result.push(item(id,string(record(value.terms).topic,"双方协作"),
      confirmedClosure ? ended[closure] : closure==="agreement_only_complete" ? "本方已记录约定，等待核对对端同步证据" : waiting[reason] || phases[string(value.phase)] || "状态尚需核对",
      needsAction ? "decision" : confirmedClosure ? "result" : reason || closure ? "waiting" : "working",needsAction,taskId));
  }
  for (const value of records(view.invitations)) result.push(item(string(value.message_id), string(value.topic, "收到合作邀请"), "先核对来源与范围，加入需你的独立决定。", "decision", true));
  const tasks = records(data.tasks);
  const known = new Set(records(view.collaborations).map(value => string(value.task_id)));
  for (const value of tasks) {
    const id = string(value.task_id), scope = record(value.scope);
    if (known.has(id)) continue;
    const state = string(value.status), title = string(scope.topic ?? scope.goal, "本方协作事项");
    result.push(item(id, title, state === "active" ? "本方委托有效；实际动作与结果请查看详情。" : state === "revoked" ? "本方委托已撤销；已发生动作仍保留。" : "请核对当前委托和执行状态。", state === "active" ? "working" : state === "pending" ? "decision" : "result", state === "pending"));
  }
  for (const operation of workspace.operations || []) if (["sending", "uncertain"].includes(operation.phase)) result.push(item(operation.call.request_id,
    "提交结果需要核实", operation.message || "保留原请求，正在核实实际结果。", "uncertain", true));
  return result.filter(value => value.id).sort((a, b) => Number(b.needsAction) - Number(a.needsAction) || b.updatedAt - a.updatedAt);
}
export function relatedTaskIds(turns: RemoteRecord[], conversationId: string, state: RemoteRecord): string[] {
  const ids = new Set<string>();
  for (const turn of turns) for (const link of records(turn.related)) {
    if (link.kind === "task") ids.add(string(link.id));
    if (link.task_id) ids.add(string(link.task_id));
  }
  for (const task of records(state.tasks)) if (record(task.source_context).conversation_id === conversationId) ids.add(string(task.task_id));
  return [...ids].filter(Boolean);
}
