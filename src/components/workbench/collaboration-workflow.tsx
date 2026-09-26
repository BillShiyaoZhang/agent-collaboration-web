"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { record, records, string, strings, type RemoteRecord } from "@/lib/control/workbench-client";
import { useLocalTime } from "@/components/local-time";
import { ActionFeedback } from "./mutation-panels";
import { buildGoalScope, capabilityLabels, collaborationMutationBlocksWrites, collaborationOperations, collaborationView, contactsForSelection, localInputToUtc, meetingProposalKind, operationMeaning, type GoalDraft } from "./collaboration-workflow-model";
import type { Workbench } from "./use-workbench";

const descriptions = new WeakMap<Workbench["invoke"], Promise<RemoteRecord | undefined>>();
export function useCollaborationDescription(w: Workbench, enabled = true) {
  const invoke = w.invoke, canMutate = w.mutations.canMutate;
  const [description, setDescription] = useState<RemoteRecord>({});
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled || !canMutate("collaboration.execute")) return;
    let current = true;
    let request = descriptions.get(invoke);
    if (!request) {
      request = invoke("collaboration.execute", { action: "describe" }).then(outcome => {
        if (!outcome.result || !Array.isArray(outcome.result.actions)) descriptions.delete(invoke);
        return outcome.result;
      });
      descriptions.set(invoke, request);
    }
    setLoading(true);
    void request.then(result => { if (current && result) setDescription(result); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [enabled, invoke, canMutate]);
  return { description, loading };
}

function withSource(w: Workbench, description: RemoteRecord, params: RemoteRecord) {
  return record(description.source_context_support).rpc_param === "source_conversation_id" && w.conversationId
    ? { ...params, source_conversation_id: w.conversationId } : params;
}

function isBusy(w: Workbench) {
  return !!w.busy["collaboration.execute"] || w.mutations.actions.some(collaborationMutationBlocksWrites);
}

export function GoalWorkflow({ workbench: w, invitation, compact = false }: { workbench: Workbench; invitation?: RemoteRecord; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const { description, loading } = useCollaborationDescription(w, open);
  const state = w.snapshots["collaboration.state"]?.data || {};
  const contacts = contactsForSelection(records(w.snapshots["contacts.list"]?.data.contacts ?? state.contacts));
  const invitationMatches = contacts.filter(contact => contact.urn === invitation?.sender_urn);
  const invitationPeer = invitationMatches.length === 1 ? invitationMatches[0] : undefined;
  const [draft, setDraft] = useState<GoalDraft>({ peerId: "", goal: "", success: "", topic: string(invitation?.topic), windows: [{ start: "", end: "" }], expiresAt: "", duration: 30, candidates: 3, actions: 12, resourceIds: [], allowPropose: !invitation, allowAccept: true, shareSlots: false });
  const [resourceTitle, setResourceTitle] = useState(""), [resourceText, setResourceText] = useState("");
  const [error, setError] = useState(""), [prepared, setPrepared] = useState("");
  const displayTime = useLocalTime();
  const peerId = invitation ? string(invitationPeer?.contact_id) : draft.peerId;
  const peer = contacts.find(contact => contact.contact_id === peerId);
  const resources = records(state.resources), capabilities = strings(description.business_capabilities);
  const availableActions = strings(description.actions);
  const baseSupported = ["prepare_task", "prepare_collaboration", "dispatch"].every(action => availableActions.includes(action));
  const allowed = w.mutations.ready && w.mutations.canMutate("collaboration.execute") && baseSupported && !isBusy(w);
  const lastAction = w.mutations.actions.slice().sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)).find(action => action.call.method === "collaboration.execute" && action.call.params.action !== "describe" && (!prepared || action.call.params.task_id === prepared));
  const update = (values: Partial<GoalDraft>) => { setDraft(previous => ({ ...previous, ...values })); setError(""); };
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    try {
      const scope = buildGoalScope({ ...draft, peerId, allowPropose: draft.allowPropose && capabilities.includes("propose_meeting"), allowAccept: draft.allowAccept && capabilities.includes("accept_meeting"), shareSlots: draft.shareSlots && capabilities.includes("share_slots"), resourceIds: capabilities.includes("share_resource") ? draft.resourceIds : [] });
      if (!allowed || !peer) return;
      const taskId = `task-${crypto.randomUUID()}`;
      setPrepared(taskId);
      await w.mutations.run("collaboration.execute", withSource(w, description, { action: "prepare_task", task_id: taskId, scope }));
    } catch (failure) { setError(failure instanceof Error ? failure.message : "请核对协作范围。"); }
  }
  const preparedTask = records(state.tasks).find(task => task.task_id === prepared);
  if (!w.available("collaboration.execute")) return <p className="text-xs leading-6 text-muted-foreground">当前宿主尚未开放网页协作。可在与自己的 agent 对话中说明目标，并查看其实际支持的能力。</p>;
  return <section className={compact ? "mt-3" : "mx-3 mb-5 rounded-2xl border bg-primary/5 p-4 sm:mx-5"} aria-label={invitation ? "核对加入协作的范围" : "发起目标协作"}>
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-semibold">{invitation ? "核对加入协作的范围" : "让 agent 与联系人合作"}</h3><p className="mt-1 text-xs leading-6 text-muted-foreground">先明确目标与范围，再核对 agent 生成的确切授权。当前支持线上会议约定与获准资料分享。</p></div><Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? "收起草案" : invitation ? "填写加入条件" : "发起协作"}</Button></div>
    {open && <div className="mt-4">
      {loading && <p role="status" className="text-xs leading-6 text-muted-foreground">正在核对本机支持的协作能力…</p>}
      {!loading && !baseSupported && <p role="status" className="mb-3 text-xs leading-6 text-muted-foreground">当前尚未核验专用流程所需的准备、授权和投递能力。请恢复连接后重试，或在高级工具中查看本机说明。</p>}
      {invitation && <p className="mb-3 break-words text-xs leading-6">收到邀请：{string(invitation.topic)}<br />对方 agent：{string(invitation.sender_urn)}<br />邀请截止：{displayTime(invitation.expires_at)}。加入需要本方独立委托与确切加入审批。</p>}
      {!preparedTask && <form onSubmit={submit} className="space-y-4">
        <label className="block text-xs font-medium">合作对象<select aria-label="合作对象" required className="mt-1.5 block min-h-11 w-full rounded-md border bg-background p-2 text-base" value={peerId} onChange={event => update({ peerId: event.target.value })} disabled={!!invitation || !allowed}><option value="">选择已建立连接的联系人</option>{contacts.map(contact => <option key={string(contact.contact_id)} value={string(contact.contact_id)}>{string(contact.label)} · {string(contact.urn)}</option>)}</select></label>
        {!contacts.length && <p className="text-xs leading-6 text-muted-foreground">请先在联系人中添加对方并等待其接受好友申请。</p>}
        {invitation && !invitationPeer && <p role="status" className="text-xs leading-6 text-amber-800">尚未找到唯一的已连接联系人，请先核对通讯录身份。</p>}
        {peer && <p className="break-all text-xs leading-6 text-muted-foreground">称呼来自你的通讯录；真实身份仍需独立核实。接收方：{string(peer.urn)}</p>}
        <label className="block text-xs font-medium">合作目标<Textarea aria-label="合作目标" required maxLength={450} className="mt-1.5" rows={2} placeholder="例如：与对方约一次产品讨论" value={draft.goal} onChange={event => update({ goal: event.target.value })} disabled={!allowed} /></label>
        <label className="block text-xs font-medium">成功标准<Input aria-label="成功标准" required maxLength={450} className="mt-1.5" placeholder="例如：双方同步确认 30 分钟线上会议约定" value={draft.success} onChange={event => update({ success: event.target.value })} disabled={!allowed} /></label>
        <label className="block text-xs font-medium">对外会议主题<Input aria-label="对外会议主题" required maxLength={500} className="mt-1.5" value={draft.topic} onChange={event => update({ topic: event.target.value })} disabled={!allowed || !!invitation} /><span className="mt-1 block font-normal leading-6 text-muted-foreground">该主题会向对方披露。目标与成功标准用于本方委托核对。</span></label>
        <fieldset className="space-y-3"><legend className="text-xs font-medium">允许的会议时间范围 · 使用本设备时区</legend>{draft.windows.map((window, index) => <div key={index} className="grid min-w-0 gap-2 rounded-xl border bg-background p-3 sm:grid-cols-2"><label className="min-w-0 text-xs">时段 {index + 1} 开始<Input aria-label={`时段 ${index + 1} 开始时间`} type="datetime-local" required className="mt-1 min-w-0 max-w-full" value={window.start} onChange={event => update({ windows: draft.windows.map((value, i) => i === index ? { ...value, start: event.target.value } : value) })} disabled={!allowed} /></label><label className="min-w-0 text-xs">时段 {index + 1} 结束<Input aria-label={`时段 ${index + 1} 结束时间`} type="datetime-local" required className="mt-1 min-w-0 max-w-full" value={window.end} onChange={event => update({ windows: draft.windows.map((value, i) => i === index ? { ...value, end: event.target.value } : value) })} disabled={!allowed} /></label>{draft.windows.length > 1 && <Button type="button" variant="ghost" size="sm" disabled={!allowed} onClick={() => update({ windows: draft.windows.filter((_, i) => i !== index) })}>删除时段 {index + 1}</Button>}</div>)}<Button type="button" variant="outline" size="sm" disabled={!allowed || draft.windows.length >= 16} onClick={() => update({ windows: [...draft.windows, { start: "", end: "" }] })}>添加另一段允许时间</Button></fieldset>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="min-w-0 text-xs">授权截止 · 本设备时区<Input aria-label="授权截止时间" required type="datetime-local" className="mt-1.5 min-w-0 max-w-full" value={draft.expiresAt} onChange={event => update({ expiresAt: event.target.value })} disabled={!allowed} /></label><label className="text-xs">最长会议时长（分钟）<Input aria-label="最长会议时长" required type="number" min={1} max={10080} className="mt-1.5" value={draft.duration} onChange={event => update({ duration: Number(event.target.value) })} disabled={!allowed} /></label><label className="text-xs">最多披露候选时段<Input aria-label="最多候选时段" required type="number" min={1} max={128} className="mt-1.5" value={draft.candidates} onChange={event => update({ candidates: Number(event.target.value) })} disabled={!allowed} /></label><label className="text-xs">最多业务动作<Input aria-label="最多业务动作" required type="number" min={1} max={100000} className="mt-1.5" value={draft.actions} onChange={event => update({ actions: Number(event.target.value) })} disabled={!allowed} /></label></div>
        <fieldset className="rounded-xl border bg-background p-3"><legend className="px-1 text-xs font-medium">允许的业务范围</legend>{[["allowPropose", "propose_meeting"], ["allowAccept", "accept_meeting"], ["shareSlots", "share_slots"]].map(([field, capability]) => capabilities.includes(capability) && <label key={field} className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={draft[field as "allowPropose" | "allowAccept" | "shareSlots"]} onChange={event => update({ [field]: event.target.checked })} disabled={!allowed} className="h-4 w-4 accent-primary" />{capabilityLabels[capability]}</label>)}<p className="mt-1 text-xs leading-6 text-muted-foreground">选择范围只形成草案；本人批准当前确切问题后才生效。有限后台运行需要双方加入后另行核对。</p></fieldset>
        {capabilities.includes("share_resource") && <details className="rounded-xl border bg-background p-3"><summary className="min-h-8 cursor-pointer text-xs font-medium">允许分享的资料 · {draft.resourceIds.length} 份</summary><p className="mt-2 text-xs leading-6 text-muted-foreground">仅支持注册文本快照。分享会发送全文，先核对来源、版本和内容；注册资料不产生分享授权。</p>{resources.map(resource => <div key={string(resource.resource_id)} className="mt-3 rounded-xl border p-3"><label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={draft.resourceIds.includes(string(resource.resource_id))} disabled={!allowed} className="h-4 w-4 accent-primary" onChange={event => update({ resourceIds: event.target.checked ? [...draft.resourceIds, string(resource.resource_id)] : draft.resourceIds.filter(id => id !== resource.resource_id) })} />{string(resource.title)}</label><p className="break-words text-xs leading-6 text-muted-foreground">{record(resource.provenance).source ? `来源：${string(record(resource.provenance).source)} · 版本：${string(record(resource.provenance).version)}` : "本方注册的文本快照"}</p><details className="mt-2"><summary className="min-h-8 cursor-pointer text-xs text-muted-foreground">核对确切全文</summary><p className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{string(resource.text)}</p></details></div>)}{availableActions.includes("register_resource") && <div className="mt-3 space-y-2 border-t pt-3"><label className="block text-xs">新文本资料标题<Input aria-label="新文本资料标题" maxLength={200} className="mt-1" value={resourceTitle} disabled={!allowed} onChange={event => setResourceTitle(event.target.value)} /></label><label className="block text-xs">确切资料全文<Textarea aria-label="新文本资料全文" maxLength={8000} className="mt-1" rows={3} value={resourceText} disabled={!allowed} onChange={event => setResourceText(event.target.value)} /></label><Button type="button" variant="outline" size="sm" disabled={!allowed || !resourceTitle.trim() || !resourceText.trim()} onClick={() => void w.mutations.run("collaboration.execute", { action: "register_resource", resource_id: `resource-${crypto.randomUUID()}`, title: resourceTitle.trim(), text: resourceText })}>注册文本快照，之后选择分享</Button></div>}</details>}
        <div className="rounded-xl bg-muted/50 p-3 text-xs leading-6"><p>将向所选联系人披露会议主题{draft.shareSlots ? "、获准候选时段" : ""}{draft.resourceIds.length ? `与 ${draft.resourceIds.length} 份所选资料全文` : ""}；其余内容不得自动扩大。线上约定不创建日历。</p><p className="mt-1 text-muted-foreground">下一步：本方任务授权 → 当前邀请 / 加入授权 → 实际投递 → 核对双方加入 → 选择人工推进或单独批准有限后台策略。</p></div>
        {error && <p role="alert" className="text-xs leading-6 text-destructive">{error}</p>}
        <Button type="submit" size="sm" disabled={!allowed || !peerId}>{prepared && lastAction?.phase === "uncertain" ? "先核实原请求" : "生成确切委托授权问题"}</Button>
      </form>}
      {preparedTask && <div className="space-y-3"><p role="status" className="text-xs leading-6">草案已在 agent 记录。请在当前授权问题中核对完整范围，再进行下一步。</p><CollaborationTaskControls workbench={w} task={preparedTask} invitation={invitation} /></div>}
      {lastAction && <ActionFeedback action={lastAction} onRetry={() => void w.mutations.retry(lastAction)} onRefresh={() => void w.mutations.refresh()} retryDisabled={!w.mutations.canMutate("collaboration.execute")} />}
    </div>}
  </section>;
}

export function CollaborationTaskControls({ workbench: w, task, collaboration, invitation }: { workbench: Workbench; task: RemoteRecord; collaboration?: RemoteRecord; invitation?: RemoteRecord }) {
  const { description, loading } = useCollaborationDescription(w);
  const [choice, setChoice] = useState(""), [error, setError] = useState("");
  const [proposalStart, setProposalStart] = useState(""), [proposalEnd, setProposalEnd] = useState("");
  const [allowPropose, setAllowPropose] = useState(false), [allowAccept, setAllowAccept] = useState(true);
  const [runs, setRuns] = useState(12), [sends, setSends] = useState(8), [interval, setInterval] = useState(60);
  const [workerExpiry, setWorkerExpiry] = useState("");
  const state = w.snapshots["collaboration.state"]?.data || {}, taskId = string(task.task_id), scope = record(task.scope);
  const view = collaborationView(state), currentCollaboration = collaboration ?? records(view.collaborations).find(item => item.task_id === taskId);
  const operations = collaborationOperations(state).filter(operation => operation.task_id === taskId);
  const actions = strings(description.actions), capabilities = strings(scope.capabilities), worker = record(task.worker);
  const peerId = string(currentCollaboration?.peer_id, strings(scope.recipient_ids)[0]);
  const collaborationId = string(currentCollaboration?.collaboration_id);
  const contactUrn = string(records(state.contacts).find(contact => contact.contact_id === peerId)?.urn);
  const matchingInvitations = invitation ? [invitation] : records(view.invitations).filter(item => !!contactUrn && item.sender_urn === contactUrn && item.topic === scope.topic);
  const active = task.status === "active", joined = currentCollaboration?.joined === true;
  const hasAgreement = !!record(currentCollaboration?.agreement).agreement_id;
  const localAcceptance = Object.entries(record(currentCollaboration?.acceptances)).some(([urn, item]) => urn !== currentCollaboration?.peer_urn && record(item).active === true);
  const anyAcceptance = Object.values(record(currentCollaboration?.acceptances)).some(item => record(item).active === true);
  const initiator = currentCollaboration?.initiator_urn !== currentCollaboration?.peer_urn;
  const allowed = w.mutations.ready && w.mutations.canMutate("collaboration.execute") && !isBusy(w);
  const can = (action: string) => allowed && actions.includes(action);
  const lastAction = w.mutations.actions.slice().sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)).find(action => action.call.method === "collaboration.execute" && (action.call.params.task_id === taskId || operations.some(operation => operation.operation_id === action.call.params.operation_id)));
  async function execute(params: RemoteRecord) {
    setError("");
    await w.mutations.run("collaboration.execute", withSource(w, description, params));
  }
  async function prepare(kind: string, payload: RemoteRecord = {}) {
    await execute({ action: "prepare_collaboration", task_id: taskId, collaboration_id: collaborationId, operation_id: `operation-${crypto.randomUUID()}`, kind, payload });
  }
  async function prepareInvitation(incoming?: RemoteRecord) {
    await execute({ action: "prepare_collaboration", task_id: taskId, collaboration_id: incoming ? incoming.collaboration_id : `collaboration-${crypto.randomUUID()}`, operation_id: `operation-${crypto.randomUUID()}`, kind: incoming ? "join" : "invite", payload: incoming ? { message_id: incoming.message_id } : { peer_id: peerId } });
  }
  function proposal() {
    const start = localInputToUtc(proposalStart, "方案开始时间"), end = localInputToUtc(proposalEnd, "方案结束时间");
    if (start >= end) throw new Error("方案结束必须晚于开始。");
    const terms = record(currentCollaboration?.terms);
    return { proposal_id: string(terms.proposal_id, `proposal-${crypto.randomUUID()}`), version: typeof terms.version === "number" ? terms.version + 1 : 1, topic: string(scope.topic), participant_ids: ["self", peerId], start, end };
  }
  async function submitChoice(event: React.FormEvent) {
    event.preventDefault(); setError("");
    try {
      if (choice === "proposal") await prepare(meetingProposalKind(currentCollaboration || {}), proposal());
      else if (choice === "worker") {
        const expires = localInputToUtc(workerExpiry, "后台策略截止时间");
        if (Date.parse(expires) > Date.parse(string(scope.expires_at)) || Date.parse(expires) <= Date.now()) throw new Error("后台策略截止必须晚于现在，且不晚于事项授权截止。");
        const proposeEnabled = allowPropose && capabilities.includes("propose_meeting") && currentCollaboration?.initiator_urn !== currentCollaboration?.peer_urn && !currentCollaboration?.terms;
        const acceptEnabled = allowAccept && capabilities.includes("accept_meeting");
        if (!proposeEnabled && !acceptEnabled) throw new Error("请选择至少一种后台能力。");
        const payload = proposeEnabled ? { ...proposal(), version: 1 } : null;
        await execute({ action: "prepare_worker_policy", task_id: taskId, policy: { collaboration_id: collaborationId, allow_propose: proposeEnabled, allow_accept: acceptEnabled, proposal: payload, max_runs: runs, max_sends: sends, interval_seconds: interval, expires_at: expires } });
      } else if (choice === "share_resource") {
        await execute({ action: "prepare_action", task_id: taskId, operation_id: `operation-${crypto.randomUUID()}`, operation: { capability: "share_resource", recipient_ids: [peerId], payload: { resource_id: resourceId } } });
      } else if (choice === "share_slots") {
        const start = localInputToUtc(proposalStart, "候选时段开始时间"), end = localInputToUtc(proposalEnd, "候选时段结束时间");
        if (start >= end) throw new Error("候选时段结束必须晚于开始。");
        await execute({ action: "prepare_action", task_id: taskId, operation_id: `operation-${crypto.randomUUID()}`, operation: { capability: "share_slots", recipient_ids: [peerId], payload: { slots: [{ start, end }] } } });
      } else if (choice === "pause") await execute({ action: "pause_worker", task_id: taskId });
      else if (choice === "revoke") await execute({ action: "revoke", task_id: taskId });
      else if (choice === "maintenance") await execute({ action: "revoke_collaboration_maintenance", collaboration_id: collaborationId });
      else await prepare(choice);
      setChoice("");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "请核对当前操作。"); }
  }
  const [resourceId, setResourceId] = useState(strings(scope.resource_ids)[0] || "");
  const resource = records(state.resources).find(item => item.resource_id === resourceId);
  const consequences: Record<string, string> = {
    pause: "暂停有限后台运行。现有委托和已发生动作保留；重新启用要核对新的策略授权。",
    revoke: "撤销本事项的业务委托，停止新的业务动作。既有接受和约定不会自动撤回；已发送内容无法召回。有限协议维护许可需单独停止。",
    withdraw: "准备撤回自己的接受。需要确切授权和实际发送，结果以对端同步为准；已形成约定时可能仍需取消流程。",
    cancel_request: "向对方请求取消已经形成的约定。对方同意并同步前，不能报告双方已取消。",
    cancel_ack: "准备同意对方当前取消请求。实际发送并核对双方状态后才显示双方已取消。",
    maintenance: "停止向对方发送固定协议维护与同步回执。已进入发送队列的消息无法召回；可能影响后续对账。",
    accept: "接受本机已核对的当前完整会议方案。Agent 会重新检查版本和范围，准备结果仍需实际投递。",
  };
  const showTimes = choice === "proposal" || choice === "share_slots" || choice === "worker" && allowPropose;
  if (!w.available("collaboration.execute")) return null;
  return <div className="mt-3 space-y-3" aria-label="事项操作">
    {loading && <p className="text-xs leading-6 text-muted-foreground">正在核对可用操作…</p>}
    {operations.filter(operation => operation.status === "ready" && operation.decision !== "deny").map(operation => <div key={string(operation.operation_id)} className="rounded-xl border bg-background p-3"><p className="text-xs font-medium">{operationMeaning(operation)} · 已准备且通过当前授权检查</p><details className="mt-1"><summary className="inline-flex min-h-8 cursor-pointer items-center text-xs text-muted-foreground">核对确切对外内容</summary><p className="mt-2 whitespace-pre-wrap break-words text-xs leading-6">{string(operation.text)}</p></details><Button type="button" className="mt-2" size="sm" disabled={!can("dispatch")} onClick={() => void execute({ action: "dispatch", operation_id: operation.operation_id })}>执行已授权的{operationMeaning(operation)}</Button><p className="mt-1 text-xs leading-6 text-muted-foreground">Agent 在发送前再次核验。进入本机队列仅代表受理，不代表对方同意。</p></div>)}
    {operations.some(operation => ["awaiting_approval", "denied"].includes(string(operation.status))) && <p className="text-xs leading-6 text-muted-foreground">{operations.some(operation => operation.kind === "join" && operation.status === "denied") ? "你选择不加入。当前只记录本方拒绝，尚未发送专用拒绝通知；不能推断对方已知。" : "需要当前确切审批的动作，请先核对授权问题；同意后仍需实际执行。"}</p>}
    {currentCollaboration && <p className="text-xs leading-6 text-muted-foreground">有限后台：{({ active: "正在按批准范围运行", disabled: "尚未开启", pending: "策略待本人批准", paused: "已暂停", revoked: "已撤销", expired: "已到期", exhausted: "预算已用尽" } as Record<string, string>)[string(worker.status)] || "状态待核验"}{!!record(worker.policy).max_runs && ` · 检查 ${Number(worker.runs_used) || 0}/${String(record(worker.policy).max_runs)} 次 · 发送 ${Number(worker.sends_used) || 0}/${String(record(worker.policy).max_sends)} 次`}</p>}
    <div className="flex flex-wrap gap-2">
      {active && !currentCollaboration && !operations.some(operation => ["invite", "join"].includes(string(operation.kind)) && operation.status !== "denied") && (matchingInvitations.length ? matchingInvitations.map(incoming => <Button key={string(incoming.message_id)} type="button" size="sm" disabled={!can("prepare_collaboration") || !peerId} onClick={() => void prepareInvitation(incoming)}>生成确切加入授权问题</Button>) : <Button type="button" size="sm" disabled={!can("prepare_collaboration") || !peerId} onClick={() => void prepareInvitation()}>生成确切邀请授权问题</Button>)}
      {active && joined && !hasAgreement && capabilities.includes("propose_meeting") && (initiator || !!currentCollaboration?.terms) && <Button type="button" variant="outline" size="sm" disabled={!can("prepare_collaboration") || initiator && anyAcceptance} onClick={() => { setChoice("proposal"); setError(""); }}>{initiator ? currentCollaboration?.terms ? "调整当前方案" : "提出会议方案" : "请求调整当前方案"}</Button>}
      {active && joined && !hasAgreement && !!currentCollaboration?.terms && capabilities.includes("accept_meeting") && <Button type="button" variant="outline" size="sm" disabled={!can("prepare_collaboration")} onClick={() => setChoice("accept")}>接受当前方案</Button>}
      {active && capabilities.includes("share_resource") && <Button type="button" variant="outline" size="sm" disabled={!can("prepare_action")} onClick={() => setChoice("share_resource")}>分享获准资料</Button>}
      {active && capabilities.includes("share_slots") && <Button type="button" variant="outline" size="sm" disabled={!can("prepare_action")} onClick={() => setChoice("share_slots")}>分享候选时段</Button>}
      {active && joined && !hasAgreement && !currentCollaboration?.withdraw_pending && !currentCollaboration?.cancel_request && string(record(description.background_worker).kind) === "finite_deterministic_meeting" && <Button type="button" variant="outline" size="sm" disabled={!can("prepare_worker_policy")} onClick={() => { setChoice("worker"); setAllowPropose(false); }}>设置有限后台范围</Button>}
      {worker.status === "active" && <Button type="button" variant="outline" size="sm" disabled={!can("pause_worker")} onClick={() => setChoice("pause")}>暂停后台运行</Button>}
      {currentCollaboration && localAcceptance && currentCollaboration.closure_reason !== "cancelled" && <Button type="button" variant="outline" size="sm" disabled={!can("prepare_collaboration")} onClick={() => setChoice("withdraw")}>撤回自己的接受</Button>}
      {hasAgreement && currentCollaboration?.closure_reason !== "cancelled" && <Button type="button" variant="outline" size="sm" disabled={!can("prepare_collaboration")} onClick={() => setChoice(currentCollaboration?.cancel_request && record(currentCollaboration.cancel_request).sender_urn === currentCollaboration.peer_urn ? "cancel_ack" : "cancel_request")}>{currentCollaboration?.cancel_request && record(currentCollaboration.cancel_request).sender_urn === currentCollaboration.peer_urn ? "回应取消约定请求" : "请求取消约定"}</Button>}
      {active && <Button type="button" variant="ghost" size="sm" disabled={!can("revoke")} onClick={() => setChoice("revoke")}>撤销业务委托</Button>}
      {currentCollaboration && record(currentCollaboration.maintenance).revoked !== true && <Button type="button" variant="ghost" size="sm" disabled={!can("revoke_collaboration_maintenance")} onClick={() => setChoice("maintenance")}>停止协议维护</Button>}
    </div>
    {active && joined && !hasAgreement && initiator && anyAcceptance && <p className="text-xs leading-6 text-muted-foreground">当前方案仍有有效接受记录。发布新版本前需核对双方撤回；本方不能替对方撤回。</p>}
    {choice && <form onSubmit={submitChoice} className="space-y-3 rounded-xl border bg-background p-3">
      <h4 className="text-xs font-semibold">{choice === "worker" ? "有限后台策略预览" : choice === "proposal" ? "当前会议方案" : choice === "share_resource" ? "分享资料全文" : choice === "share_slots" ? "分享候选时段" : "核对本次操作后果"}</h4>
      {consequences[choice] && <p className="text-xs leading-6">{consequences[choice]}</p>}
      {choice === "accept" && <p className="whitespace-pre-wrap break-words text-xs leading-6">{string(record(currentCollaboration?.terms).topic)}<br />当前第 {String(record(currentCollaboration?.terms).version)} 版；请在事项详情核对时间与完整条款。无历史版本证据时，不显示推测的差异。</p>}
      {choice === "worker" && <><p className="text-xs leading-6 text-muted-foreground">只运行有限、固定的会议程序。接受仅限原委托范围；不调用模型、不任意发消息、不读取私人记忆、不创建日历。例外、结果不确定或预算耗尽即停止。</p>{capabilities.includes("propose_meeting") && currentCollaboration?.initiator_urn !== currentCollaboration?.peer_urn && !currentCollaboration?.terms && <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={allowPropose} disabled={!allowed} onChange={event => setAllowPropose(event.target.checked)} className="h-4 w-4 accent-primary" />允许发送下面唯一固定的第 1 版方案</label>}{capabilities.includes("accept_meeting") && <label className="flex min-h-11 items-center gap-2 text-xs"><input type="checkbox" checked={allowAccept} disabled={!allowed} onChange={event => setAllowAccept(event.target.checked)} className="h-4 w-4 accent-primary" />允许接受符合原委托的当前方案</label>}<div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="text-xs">最多检查次数<Input aria-label="后台最多检查次数" type="number" min={1} max={100} value={runs} onChange={event => setRuns(Number(event.target.value))} required /></label><label className="text-xs">最多发送次数<Input aria-label="后台最多发送次数" type="number" min={1} max={32} value={sends} onChange={event => setSends(Number(event.target.value))} required /></label><label className="text-xs">检查间隔（秒）<Input aria-label="后台检查间隔" type="number" min={15} max={3600} value={interval} onChange={event => setInterval(Number(event.target.value))} required /></label><label className="min-w-0 text-xs">策略截止 · 本设备时区<Input aria-label="后台策略截止时间" type="datetime-local" className="min-w-0 max-w-full" value={workerExpiry} onChange={event => setWorkerExpiry(event.target.value)} required /></label></div></>}
      {showTimes && <div className="grid min-w-0 gap-3 sm:grid-cols-2"><label className="min-w-0 text-xs">开始 · 本设备时区<Input aria-label="方案开始时间" required type="datetime-local" className="mt-1 min-w-0 max-w-full" value={proposalStart} onChange={event => setProposalStart(event.target.value)} /></label><label className="min-w-0 text-xs">结束 · 本设备时区<Input aria-label="方案结束时间" required type="datetime-local" className="mt-1 min-w-0 max-w-full" value={proposalEnd} onChange={event => setProposalEnd(event.target.value)} /></label></div>}
      {choice === "share_resource" && <><label className="block text-xs">选取委托已允许的资料<select aria-label="分享的资料" className="mt-1 block min-h-11 w-full rounded-md border bg-background p-2 text-base" required value={resourceId} onChange={event => setResourceId(event.target.value)}><option value="">选择资料</option>{records(state.resources).filter(item => strings(scope.resource_ids).includes(string(item.resource_id))).map(item => <option key={string(item.resource_id)} value={string(item.resource_id)}>{string(item.title)}</option>)}</select></label>{resource && <p className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs leading-6">{string(resource.text)}</p>}<p className="text-xs leading-6 text-muted-foreground">分享发送的是这份已注册快照全文。已发送内容无法召回。</p></>}
      {error && <p role="alert" className="text-xs leading-6 text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={!allowed || choice === "share_resource" && !resource}>{["pause", "revoke", "maintenance"].includes(choice) ? "确认执行本次操作" : "准备本次动作并核对授权"}</Button><Button type="button" size="sm" variant="ghost" onClick={() => { setChoice(""); setError(""); }}>返回</Button></div>
    </form>}
    {error && !choice && <p role="alert" className="text-xs text-destructive">{error}</p>}
    {lastAction && <ActionFeedback action={lastAction} onRetry={() => void w.mutations.retry(lastAction)} onRefresh={() => void w.mutations.refresh()} retryDisabled={!w.mutations.canMutate("collaboration.execute")} />}
    {!w.mutations.canMutate("collaboration.execute") && <p className="text-xs leading-6 text-muted-foreground">本机协作控制未获准或已过期。当前内容可继续查看；请在连接设置恢复所需权限。</p>}
  </div>;
}
