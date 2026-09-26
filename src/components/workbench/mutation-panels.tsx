"use client";

import { useState } from "react";
import { Check, Loader2, Plus, RefreshCw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RemoteRecord, stateLabel, string, strings } from "@/lib/control/workbench-client";
import { useHydrated, useLocalTime } from "@/components/local-time";
import { cn } from "@/lib/shared/utils";
import type { Workbench } from "./use-workbench";
import type { MutationState } from "./use-workbench-mutations";

export function ActionFeedback({ action, onRetry, onRestart, onRefresh, retryDisabled }: {
  action: MutationState; onRetry?: () => void; onRestart?: () => void; onRefresh: () => void; retryDisabled?: boolean;
}) {
  return <div role={action.phase === "failed" ? "alert" : "status"} className={cn("mt-3 rounded-xl border px-3 py-3 text-xs leading-6",
    action.phase === "failed" ? "border-rose-200 bg-rose-50 text-rose-900" : action.phase === "succeeded"
      ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-950")}>
    <p className="flex items-start gap-2">{action.phase === "sending" ? <Loader2 className="mt-1 h-4 w-4 shrink-0 animate-spin" /> : action.phase === "succeeded" ? <Check className="mt-1 h-4 w-4 shrink-0" /> : null}<span>{action.message}</span></p>
    {action.phase === "uncertain" && <p className="mt-1">{action.call.method === "collaboration.execute" && !action.retryable ? "请先通过本机 agent 或查询功能核实结果；此动作不会自动重新执行。" : action.retryable ? "请保留这条记录。重试会继续本次提交，不会创建新的操作。" : "旧请求已无法重试。请先刷新核实；如果仍未完成，可重新提交相同内容，agent 会核查是否已处理。"}</p>}
    {(action.phase === "uncertain" || action.phase === "failed") && <div className="mt-2 flex flex-wrap gap-2">
      {action.retryable && onRetry && <Button type="button" variant="outline" size="sm" disabled={retryDisabled} onClick={onRetry}>重试本次{action.call.method === "contacts.add" ? "添加" : "回应"}</Button>}
      {action.phase === "uncertain" && !action.retryable && action.call.method !== "collaboration.execute" && onRestart && <Button type="button" variant="outline" size="sm" disabled={retryDisabled} onClick={onRestart}>重新提交相同内容</Button>}
      <Button type="button" variant="ghost" size="sm" onClick={onRefresh}><RefreshCw className="h-3.5 w-3.5" />刷新核实结果</Button>
    </div>}
  </div>;
}

export function AddContactPanel({ workbench: w }: { workbench: Workbench }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [aliasText, setAliasText] = useState("");
  const [urn, setUrn] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const action = w.mutations.contactAction;
  const locked = action && ["sending", "uncertain", "succeeded"].includes(action.phase);
  const allowed = w.canAddContact && w.mutations.ready;
  const aliases = Array.from(new Set([name.trim(), ...aliasText.split(/[,，、\n]/).map(alias => alias.trim())].filter(Boolean)));
  const shown = open || !!action;

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    if (!allowed || locked || !confirmed) return;
    if (!name.trim() || aliases.length > 16 || aliases.some(alias => alias.length > 100)) { setError("请填写姓名；姓名和别名合计最多 16 个，每个最多 100 字。"); return; }
    if (urn.trim().length > 256 || !/^urn:[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(urn.trim())) { setError("请填写完整的联系人 URN，例如 urn:agent-comm:agent:…。"); return; }
    void w.mutations.addContact({ contact_id: `contact-${crypto.randomUUID()}`, aliases, urn: urn.trim() });
  }

  return <section className="mx-3 mb-5 rounded-2xl border bg-muted/20 p-3 sm:mx-5 sm:p-4" aria-label="添加联系人">
    <div className="flex flex-wrap items-start justify-between gap-3"><div>{shown && <h3 className="text-sm font-medium">添加联系人</h3>}{open && !locked && <p className="mt-1 text-xs leading-6 text-muted-foreground">填写对方的称呼与 URN，本机 agent 会将好友请求排队并尝试投递。对方收到并接受后，双方才建立通讯录连接，可以互发普通消息。若这个 URN 已在通讯录且上次请求被拒绝，请从该联系人卡片重新发起。</p>}</div>
      {!shown && <Button type="button" size="sm" className="h-auto max-w-full whitespace-normal py-2 text-center" disabled={!allowed} onClick={() => setOpen(true)}><Plus className="h-4 w-4 shrink-0" />添加联系人</Button>}
    </div>
    {!w.canAddContact && <p className="mt-2 text-xs leading-6 text-muted-foreground">{w.available("contacts.add") ? "此连接的授权已失效，请先在连接设置中重新配对。" : "当前连接尚未开放在网页添加联系人，请在连接设置中检查授权。"}</p>}
    {w.mutations.storageError && <div role="alert" className="mt-2 text-xs leading-6 text-destructive"><p>{w.mutations.storageError}</p><Button type="button" variant="ghost" size="sm" onClick={w.mutations.recoverStorage}>重试保存操作记录</Button></div>}
    {shown && !locked && <form onSubmit={submit} className="mt-4 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2"><div><label htmlFor="contact-name" className="text-xs font-medium">姓名或称呼</label><Input id="contact-name" autoComplete="off" required maxLength={100} value={name} onChange={event => { setName(event.target.value); setConfirmed(false); }} placeholder="例如：小王" className="mt-1.5" disabled={!allowed} /></div><div><label htmlFor="contact-aliases" className="text-xs font-medium">其他别名 <span className="font-normal text-muted-foreground">（可选）</span></label><Input id="contact-aliases" autoComplete="off" value={aliasText} onChange={event => { setAliasText(event.target.value); setConfirmed(false); }} placeholder="多个别名用逗号分隔" className="mt-1.5" disabled={!allowed} /></div></div>
      <div><label htmlFor="contact-urn" className="text-xs font-medium">对方的 URN</label><Input id="contact-urn" autoComplete="off" autoCapitalize="none" spellCheck={false} required maxLength={256} value={urn} onChange={event => { setUrn(event.target.value); setConfirmed(false); }} placeholder="urn:agent-comm:agent:…" className="mt-1.5 font-mono text-base" disabled={!allowed} /><p className="mt-1.5 text-xs leading-6 text-muted-foreground">请通过可信渠道获取对方 agent 的准确 URN。v0.9.1 helper 可自动核对公钥；旧 v0.8.0 仍要求双方在本机核对并固定完整公钥。请按实际安装版本操作。</p></div>
      <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border bg-background p-3 text-xs leading-6"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={!allowed || !name.trim() || !urn.trim()} className="mt-1 h-4 w-4 shrink-0 accent-primary" /><span>我确认向以下 URN 发起好友申请，{aliases.length ? `「${aliases.join("、")}」` : "以上称呼"}仅用于我的通讯录：<span className="mt-1 block break-all font-mono">{urn.trim() || "填写后将在这里显示"}</span><span className="mt-1 block text-muted-foreground">请求可能仍待投递；接受只开通普通消息，不代表已核实对方现实身份或授予协作权限。</span></span></label>
      {error && <p role="alert" className="text-xs leading-6 text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2"><Button type="submit" size="sm" disabled={!allowed || !confirmed || !name.trim() || !urn.trim()}>添加并排队好友请求</Button><Button type="button" variant="ghost" size="sm" onClick={() => { setOpen(false); setError(""); w.mutations.clearContact(); }}>取消</Button></div>
    </form>}
    {locked && action && <div className="mt-4 rounded-xl border bg-background p-3"><p className="text-sm font-medium">{strings(action.call.params.aliases).join(" · ")}</p><p className="mt-1 break-all font-mono text-xs leading-6 text-muted-foreground">{string(action.call.params.urn)}</p></div>}
    {action && <ActionFeedback action={action} onRetry={() => void w.mutations.retry(action)} onRestart={() => void w.mutations.restart(action)} onRefresh={() => void w.mutations.refresh()} retryDisabled={!allowed} />}
    {action?.phase === "succeeded" && <Button type="button" variant="outline" size="sm" className="mt-3" disabled={!allowed} onClick={() => { w.mutations.clearContact(); setName(""); setAliasText(""); setUrn(""); setConfirmed(false); setError(""); setOpen(true); }}><Plus className="h-3.5 w-3.5" />添加另一位联系人</Button>}
  </section>;
}

export function ApprovalRequests({ approvals, workbench: w }: { approvals: RemoteRecord[]; workbench: Workbench }) {
  const displayTime = useLocalTime();
  const hydrated = useHydrated();
  const recent = w.mutations.approvalActions.filter(action => !approvals.some(approval => approval.approval_id === action.call.params.approval_id));
  if (!approvals.length && !recent.length) return null;
  if (!approvals.length && recent.every(action => action.phase === "succeeded")) return <details className="mx-5 mb-5 rounded-2xl border p-4" aria-label="最近的授权回应"><summary className="cursor-pointer text-sm font-medium">最近的授权回应 · {recent.length} 项</summary>{recent.map(action => <div key={action.call.request_id} className="mt-3 border-t pt-3"><p className="text-xs leading-6 text-muted-foreground">已提交{action.call.params.decision === "approve" ? "同意" : "拒绝"}。最新同步内容中已没有这条待确认请求，可查看事项进展核实。</p><ActionFeedback action={action} onRefresh={() => void w.mutations.refresh()} /></div>)}</details>;
  return <section className="mx-5 mb-5 rounded-2xl border border-amber-200/80 bg-amber-50/50 p-4" aria-label="授权确认">
    <div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" /><div><h3 className="text-sm font-semibold text-amber-950">{approvals.length ? `${approvals.length} 项需要你确认` : "最近的授权回应"}</h3><p className="mt-1 text-xs leading-6 text-amber-800">请核对完整请求后选择同意或拒绝，处理结果会从 agent 同步。</p></div></div>
    {!w.canRespondApproval && <p className="mt-3 text-xs leading-6 text-amber-900">{w.available("approval.respond") ? "此连接的授权已失效，请先在连接设置中重新配对。" : "当前连接尚未开放网页授权确认。请检查连接设置，或从 agent 的原生渠道回应。"}</p>}
    {w.mutations.storageError && <div role="alert" className="mt-2 text-xs leading-6 text-destructive"><p>{w.mutations.storageError}</p><Button type="button" variant="ghost" size="sm" onClick={w.mutations.recoverStorage}>重试保存操作记录</Button></div>}
    <div className="mt-3 divide-y divide-amber-200/60">{approvals.map((approval, index) => {
      const id = string(approval.approval_id), question = string(approval.question), status = string(approval.status);
      const action = w.mutations.approvalActions.find(item => item.call.params.approval_id === id);
      const expiry = typeof approval.expires_at === "number" ? approval.expires_at * (approval.expires_at < 1e12 ? 1000 : 1) : Date.parse(string(approval.expires_at));
      const expired = status === "expired" || hydrated && Number.isFinite(expiry) && expiry <= Date.now();
      const canDecide = !!id && !!question.trim() && ["pending", "presenting", "expired"].includes(status) && w.canRespondApproval && w.mutations.ready;
      const locked = w.mutations.approvalBusy || !!action && ["sending", "uncertain", "succeeded"].includes(action.phase);
      return <details id={`subject-${id}`} key={id || String(index)} open className="py-4"><summary className="cursor-pointer break-words text-sm font-medium">{string(approval.subject_id, "待确认请求")}<span className="ml-2 text-xs font-normal text-amber-800">{stateLabel(status)}</span></summary>
        <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-7">{question || "本次同步缺少请求内容，请刷新后再回应。"}</p>
        {approval.expires_at !== undefined && <p className="mt-2 text-xs leading-6 text-muted-foreground">本次确认展示有效至：{displayTime(approval.expires_at) || "未提供"}</p>}
        {expired && <p className="mt-2 text-xs leading-6 text-amber-900">上次确认展示已过期，请重新核对以上内容。Agent 会检查事项是否仍然有效。</p>}
        <div className="mt-3 flex flex-wrap gap-2"><Button type="button" size="sm" disabled={!canDecide || locked} onClick={() => void w.mutations.respondApproval(id, "approve")}>同意本次请求</Button><Button type="button" variant="outline" size="sm" disabled={!canDecide || locked} onClick={() => void w.mutations.respondApproval(id, "deny")}>拒绝本次请求</Button></div>
        {action && <><p className="mt-3 text-xs text-muted-foreground">你提交的选择：{action.call.params.decision === "approve" ? "同意" : "拒绝"}</p><ActionFeedback action={action} onRetry={() => void w.mutations.retry(action)} onRestart={() => void w.mutations.restart(action)} onRefresh={() => void w.mutations.refresh()} retryDisabled={!canDecide || w.mutations.approvalBusy} /></>}
      </details>;
    })}</div>
    {recent.map(action => <div key={action.call.request_id} className="mt-3 border-t border-amber-200/60 pt-3"><p className="text-xs leading-6 text-muted-foreground">已提交{action.call.params.decision === "approve" ? "同意" : "拒绝"}。最新同步内容中已没有这条待确认请求，可查看事项进展核实。</p><ActionFeedback action={action} onRefresh={() => void w.mutations.refresh()} /></div>)}
  </section>;
}
