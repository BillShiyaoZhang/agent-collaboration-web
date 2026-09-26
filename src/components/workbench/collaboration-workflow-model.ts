import { record, records, string, strings, type RemoteRecord } from "@agent-comm/client-contract";

export type GoalDraft = {
  peerId: string; goal: string; success: string; topic: string;
  windows: { start: string; end: string }[]; expiresAt: string;
  duration: number; candidates: number; actions: number; resourceIds: string[];
  allowPropose: boolean; allowAccept: boolean; shareSlots: boolean;
};

export const capabilityLabels: Record<string, string> = {
  share_slots: "分享候选时段", share_resource: "分享所选资料全文", propose_meeting: "提出会议方案",
  accept_meeting: "接受范围内会议方案", send_text: "逐次核对后发送文本",
};

export function collaborationMutationBlocksWrites(action: { phase: string; call: { method: string; params: RemoteRecord } }) {
  return action.call.method === "collaboration.execute" && action.call.params.action !== "describe" && ["sending", "uncertain"].includes(action.phase);
}

export function collaborationView(data: RemoteRecord) {
  return Array.isArray(data.collaborations) ? data : record(data.collaboration ?? data.collaboration_v2);
}

export function collaborationOperations(data: RemoteRecord) {
  const byId = new Map<string, RemoteRecord>();
  for (const operation of [...records(data.operations), ...records(collaborationView(data).operations)]) {
    const id = string(operation.operation_id);
    if (id) byId.set(id, operation);
  }
  return [...byId.values()];
}

export function contactsForSelection(data: RemoteRecord[]): (RemoteRecord & { label: string })[] {
  return data.filter(contact => contact.connection_status === "connected" && string(contact.contact_id) !== "self" && !!string(contact.urn))
    .map(contact => ({ ...contact, label: strings(contact.aliases)[0] || string(contact.alias, string(contact.contact_id, "联系人")) }));
}

export function localInputToUtc(value: string, label: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error(`请填写${label}。`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${label}无效。`);
  const parts = [parsed.getFullYear(), parsed.getMonth() + 1, parsed.getDate(), parsed.getHours(), parsed.getMinutes()];
  const expected = value.match(/\d+/g)?.map(Number);
  if (!expected || parts.some((part, index) => part !== expected[index])) throw new Error(`${label}不是本设备时区中的有效时间。`);
  return parsed.toISOString();
}

export function buildGoalScope(draft: GoalDraft, now = Date.now()): RemoteRecord {
  const purpose = `目标：${draft.goal.trim()}\n成功标准：${draft.success.trim()}`;
  if (!draft.peerId || !draft.goal.trim() || !draft.success.trim() || !draft.topic.trim()) throw new Error("请选择联系人，并填写目标、成功标准和主题。");
  if (purpose.length > 1000 || draft.topic.trim().length > 500) throw new Error("目标与成功标准合计最多 990 字，主题最多 500 字。");
  const windows = draft.windows.map((window, index) => ({ start: localInputToUtc(window.start, `时段 ${index + 1} 开始时间`), end: localInputToUtc(window.end, `时段 ${index + 1} 结束时间`) }));
  if (!windows.length || windows.length > 16 || windows.some(window => window.start >= window.end)) throw new Error("请提供 1 至 16 个结束晚于开始的候选时间范围。");
  const expires = localInputToUtc(draft.expiresAt, "授权截止时间");
  if (Date.parse(expires) <= now) throw new Error("授权截止时间必须晚于现在。");
  const bounds: [number, number, string][] = [[draft.duration, 10080, "最长会议分钟数"], [draft.candidates, 128, "最多候选时段"], [draft.actions, 100000, "最多业务动作"]];
  if (bounds.some(([value, maximum]) => !Number.isInteger(value) || value < 1 || value > maximum)) throw new Error("请填写有效的会议时长、候选数量和动作预算。");
  const capabilities = [draft.allowPropose && "propose_meeting", draft.allowAccept && "accept_meeting", draft.shareSlots && "share_slots", draft.resourceIds.length > 0 && "share_resource"].filter(Boolean);
  if (!capabilities.length) throw new Error("请选择至少一项允许能力。");
  return { purpose, topic: draft.topic.trim(), capabilities, recipient_ids: [draft.peerId], participant_ids: ["self", draft.peerId], resource_ids: [...new Set(draft.resourceIds)],
    window_start: windows.map(window => window.start).sort()[0], window_end: windows.map(window => window.end).sort().at(-1), allowed_windows: windows,
    max_duration_minutes: draft.duration, max_candidates: draft.candidates, max_actions: draft.actions, expires_at: expires };
}

export function operationMeaning(operation: RemoteRecord) {
  const kind = string(operation.kind), capability = string(record(operation.action).capability);
  return ({ invite: "邀请对方加入", join: "加入此协作", proposal: "提出会议方案", change_request: "调整会议方案", accept: "接受当前会议方案", withdraw: "撤回自己的接受", cancel_request: "请求取消双方约定", cancel_ack: "同意取消双方约定" } as Record<string, string>)[kind]
    || capabilityLabels[capability] || "协作动作";
}

export function meetingProposalKind(collaboration: RemoteRecord) {
  return collaboration.initiator_urn === collaboration.peer_urn ? "change_request" : "proposal";
}

export function currentApprovalsForTask(data: RemoteRecord, taskId: string) {
  const operations = collaborationOperations(data).filter(operation => operation.task_id === taskId);
  const ids = new Set(operations.map(operation => string(operation.operation_id)));
  const approvalIds = new Set(operations.map(operation => string(operation.approval_id)).filter(Boolean));
  return records(data.pending_confirmations).filter(approval => approval.task_id === taskId || approval.subject_id === taskId || ids.has(string(approval.subject_id)) || approvalIds.has(string(approval.approval_id)));
}

export function taskJudgment(data: RemoteRecord, task: RemoteRecord, collaboration?: RemoteRecord) {
  const taskId = string(task.task_id), scope = record(task.scope), approvals = currentApprovalsForTask(data, taskId);
  const worker = record(task.worker), reason = string(collaboration?.waiting_reason), closure = string(collaboration?.closure_reason);
  const operations = collaborationOperations(data).filter(operation => operation.task_id === taskId);
  const uncertain = operations.some(operation => operation.status === "sending" || operation.status === "uncertain") || collaboration?.withdraw_pending === true;
  const cancellation = record(collaboration?.cancel_request);
  const peerCancellation = reason === "cancel_decision" && cancellation.sender_urn === collaboration?.peer_urn;
  const waitingPeerCancellation = reason === "cancel_decision" && !!cancellation.sender_urn && cancellation.sender_urn !== collaboration?.peer_urn;
  const needsOwner = approvals.length > 0 || ["maintenance_permission", "maintenance_budget", "event_chain_conflict", "withdrawal_decision", "owner_decision"].includes(reason) || peerCancellation || ["exhausted", "expired"].includes(string(worker.status));
  const ready = operations.some(operation => operation.status === "ready" && operation.decision !== "deny");
  const complete = closure === "agreement_only_complete" && collaboration?.agreement_synced === true;
  const progress = closure === "cancelled" ? "双方已确认取消约定" : complete ? "双方已同步同版约定" : task.status === "revoked" ? "委托已撤销，停止新的业务动作；既有协作结果保留" : collaboration?.agreement ? "本方已记录约定，核对对端同步结果" : collaboration?.joined === true ? "双方已加入，协调当前方案" : collaboration ? "邀请已进入协作流程，尚未确认双方加入" : task.status === "active" ? "委托已授权，尚未邀请或加入" : "委托范围等待本人确认";
  const next = uncertain ? "先核实原动作；不要重复发送" : approvals.length ? "本人核对当前确切问题" : ready ? "本人执行已授权的确切动作" : complete || closure === "cancelled" ? "查看结果；需要时继续讨论" : waitingPeerCancellation ? "等待对方回应取消约定请求；当前无需重复发送" : peerCancellation ? "本人核对对方的取消约定请求" : task.status === "revoked" ? "查看已发生动作；必要时单独处理撤回或取消" : needsOwner ? "本人检查当前恢复事项" : collaboration?.joined === true ? worker.status === "active" ? "有限后台程序按已批准策略推进" : "本人选择方案或设置有限后台范围" : collaboration ? "等待对方加入；当前无需重复邀请" : "本人准备邀请或核对收到的邀请";
  return { goal: string(scope.purpose, string(scope.topic, "未提供目标")), progress, next,
    owner: uncertain ? "先核实结果" : approvals.length || ready ? "需要本人操作" : complete || closure === "cancelled" ? "无需作授权决定" : waitingPeerCancellation ? "当前无需本人操作" : needsOwner || !collaboration ? "需要本人操作" : collaboration.joined === true && worker.status !== "active" ? "需要选择下一步" : "当前无需本人操作",
    result: complete ? "已形成并同步线上会议约定。未创建日历，尚不代表会议已举行。" : closure === "cancelled" ? "已有双方取消结果；已披露的资料仍保留。" : collaboration?.agreement ? "约定已在本方记录，等待完整同步证据。" : "尚无双方完成结果。", approvals, operations };
}

export function peerCommunication(incoming: RemoteRecord[], sent: RemoteRecord[], urn: string): (RemoteRecord & { direction: string })[] {
  return [...incoming.filter(message => message.sender_urn === urn).map(message => ({ ...message, direction: "incoming" } as RemoteRecord & { direction: string })),
    ...sent.filter(message => message.recipient_urn === urn).map(message => ({ ...message, direction: "outgoing" } as RemoteRecord & { direction: string }))]
    .sort((a, b) => Number(a.received_at || a.created_at || 0) - Number(b.received_at || b.created_at || 0));
}
