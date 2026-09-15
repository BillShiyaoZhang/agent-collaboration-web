"use client";

import { record, records, string, strings, displayTime, type RemoteRecord } from "@/lib/control/workbench-client";

const phases: Record<string, string> = { invited: "已发起邀请", negotiating: "正在协商", partially_accepted: "部分接受，等待另一方", agreed: "已形成双方约定", reconciling: "正在核对双方状态", closed: "本轮协作已结束" };
const waiting: Record<string, string> = { agreement_sync: "等待对方核对约定", agreement_ack: "等待约定同步回执", agreement_ack_delivery: "同步回执正在投递", missing_event: "正在补齐缺失事件", withdrawal_decision: "撤回结果需要核实", cancel_decision: "等待取消决定", maintenance_permission: "需要续期或调整后续同步权限", maintenance_budget: "后续同步预算已用尽，需要本人决定", event_chain_conflict: "双方事件记录存在冲突，需要核对", owner_decision: "等待本人决定", peer_join: "等待对方加入", peer_accept: "等待对方接受" };
const closed: Record<string, string> = { agreement_only_complete: "双方已同步约定", cancelled: "双方已取消约定", withdrawn: "已撤回接受", expired: "已到期" };

export function CollaborationSnapshot({ data }: { data: RemoteRecord }) {
  const view = Array.isArray(data.collaborations) ? data : record(data.collaboration ?? data.collaboration_v2);
  const collaborations = records(view.collaborations), invitations = records(view.invitations);
  if (!collaborations.length && !invitations.length) return null;
  return <section className="space-y-3 px-5 pb-5" aria-label="双方协作">
    <div><h3 className="text-sm font-semibold">双方协作</h3><p className="mt-1 text-xs leading-6 text-muted-foreground">本阶段协调双方约定，尚未创建日历事件。对方的授权依据为其 agent 声明。</p></div>
    {invitations.map((invitation, index) => <article key={string(invitation.message_id, String(index))} id={`subject-${string(invitation.message_id)}`} className="rounded-2xl border p-4"><p className="text-xs text-muted-foreground">收到协作邀请 · 对端声明</p><h4 className="mt-2 font-medium">{string(invitation.topic, "协作邀请")}</h4><p className="mt-2 break-all text-xs text-muted-foreground">{string(invitation.sender_urn)}</p><p className="mt-2 text-xs">请先核对联系人和授权范围。若有待确认请求，可在网页中点击同意或拒绝，或在 agent 原生渠道回应。</p></article>)}
    {collaborations.map((collaboration, index) => {
      const id = string(collaboration.collaboration_id, String(index)), terms = record(collaboration.terms), agreement = record(collaboration.agreement);
      const acceptanceEntries = Object.entries(record(collaboration.acceptances));
      const phase = string(collaboration.phase), reason = string(collaboration.waiting_reason), closure = string(collaboration.closure_reason);
      return <article key={id} id={`subject-${string(collaboration.task_id, id)}`} className="rounded-2xl border p-4">
        <div className="flex flex-wrap items-start justify-between gap-2"><h4 className="font-medium">{string(terms.topic, "双方协作事项")}</h4><span className={`rounded-full px-2.5 py-1 text-[11px] ${phase === "agreed" || closure === "agreement_only_complete" ? "bg-emerald-50 text-emerald-800" : "bg-muted text-muted-foreground"}`}>{phase === "closed" && closed[closure] ? closed[closure] : phases[phase] || "状态待核对"}</span></div>
        <p className="mt-2 break-all text-[11px] text-muted-foreground">协作 {id}</p>
        <dl className="mt-4 grid gap-2 text-xs leading-6 sm:grid-cols-2"><div><dt className="text-muted-foreground">对方 agent</dt><dd className="break-all">{string(collaboration.peer_urn, "待确认")}</dd></div><div><dt className="text-muted-foreground">条款版本</dt><dd>{typeof terms.version === "number" ? `第 ${terms.version} 版` : "尚未提出方案"}</dd></div>{!!terms.start && <div><dt className="text-muted-foreground">时间</dt><dd>{displayTime(terms.start)} — {displayTime(terms.end)}</dd></div>}{Array.isArray(terms.participant_ids) && <div><dt className="text-muted-foreground">参与方</dt><dd className="break-all">{strings(terms.participant_ids).join("、")}</dd></div>}</dl>
        {reason && <p className="mt-3 text-xs text-amber-800">{waiting[reason] || "仍有协作状态需要核对"}</p>}
        {collaboration.withdraw_pending === true && <p className="mt-2 text-xs text-amber-800">撤回请求正在核实，尚不能视为对方已收到。</p>}
        <div className="mt-4 rounded-xl bg-muted/40 p-3"><p className="text-xs font-medium">双方接受记录</p>{!acceptanceEntries.length ? <p className="mt-2 text-xs text-muted-foreground">尚无结构化接受记录。</p> : acceptanceEntries.map(([urn, value]) => { const acceptance = record(value); return <div key={urn} className="mt-2 border-t pt-2 text-xs leading-6"><p className="break-all">{urn}</p><p>{acceptance.active === true ? "已记录接受" : "接受已失效或撤回"} · 仅承担本人参会义务</p><p className="break-all text-[11px] text-muted-foreground">条款摘要 {string(acceptance.terms_digest, "未提供")}</p></div>; })}</div>
        {!!agreement.agreement_id && <div className="mt-3 text-xs leading-6"><p className="break-all">约定编号：{string(agreement.agreement_id)}</p><p>{collaboration.agreement_synced === true ? "约定已有对端同步回执。" : "约定已在本地记录，正在等待对端同步回执。"}</p><p className="text-muted-foreground">日历创建：尚未执行</p></div>}
      </article>;
    })}
  </section>;
}
