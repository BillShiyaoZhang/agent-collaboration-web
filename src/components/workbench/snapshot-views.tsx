"use client";

import { useState } from "react";
import { ArrowDownLeft, Check, ChevronDown, ClipboardList, Copy, Inbox, Search, ShieldAlert, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { displayTime, record, records, RemoteRecord, stateLabel, string, strings } from "@/lib/workbench-client";

export function CopyValue({ value, label = "复制", compact = false }: { value: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return <span className="inline-flex shrink-0 items-center gap-2">
    <Button type="button" variant="ghost" size={compact ? "icon" : "sm"} aria-label={copied ? "已复制" : label} title={copied ? "已复制" : label} className={compact ? "h-8 w-8 rounded-lg" : "gap-1.5 rounded-lg"} onClick={async () => {
      try { await navigator.clipboard.writeText(value); setCopied(true); setFailed(false); setTimeout(() => setCopied(false), 2000); }
      catch { setFailed(true); }
    }}>{copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}{!compact && (copied ? "已复制" : label)}</Button>
    {failed && <span role="status" className="text-xs text-muted-foreground">请选中文字复制</span>}
  </span>;
}

export function StatusBadge({ value }: { value: unknown }) {
  const status = string(value);
  const color = ["failed", "interrupted", "expired", "denied", "revoked"].includes(status) ? "bg-rose-50 text-rose-700" :
    ["completed", "active", "approved"].includes(status) ? "bg-emerald-50 text-emerald-700" :
      ["pending", "presenting", "awaiting_approval"].includes(status) ? "bg-amber-50 text-amber-800" : "bg-muted text-muted-foreground";
  return <span className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${color}`}>{stateLabel(value)}</span>;
}

export function EmptySnapshot({ kind, filtered = false }: { kind: "contacts" | "tasks" | "inbox"; filtered?: boolean }) {
  const Icon = kind === "contacts" ? Users : kind === "tasks" ? ClipboardList : Inbox;
  const descriptions = {
    contacts: ["联系人会出现在这里", "在 agent 的原生对话中确认联系人后，会自动同步到这里。"],
    tasks: ["暂时没有协作事项", "交给 agent 的协作事项和待确认请求，会在这里汇集。"],
    inbox: ["收件箱很安静", "来自已确认联系人的消息，会在这里显示。"],
  };
  return <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center"><span className="mb-4 rounded-2xl bg-muted p-4"><Icon className="h-7 w-7 text-muted-foreground" strokeWidth={1.5} /></span><h3 className="font-medium">{filtered ? "没有匹配的结果" : descriptions[kind][0]}</h3><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{filtered ? "试试其他姓名、别名或 URN。" : descriptions[kind][1]}</p></div>;
}

export function RawSnapshot({ data }: { data: unknown }) {
  return <details className="group border-t px-5 py-3"><summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />查看原始快照</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/60 p-4 text-xs leading-6">{JSON.stringify(data, null, 2)}</pre></details>;
}

export function ContactsSnapshot({ data }: { data: RemoteRecord }) {
  const [query, setQuery] = useState("");
  const contacts = records(data.contacts);
  const visible = contacts.filter(contact => [string(contact.contact_id), string(contact.urn), string(contact.alias), ...strings(contact.aliases)].join(" ").toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    {!!contacts.length && <div className="px-5 pb-4"><div className="relative max-w-sm"><Search aria-hidden className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input aria-label="搜索联系人" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索姓名、别名或 URN" className="rounded-xl bg-muted/40 pl-9" /></div></div>}
    {!visible.length ? <EmptySnapshot kind="contacts" filtered={!!query} /> : <div className="grid gap-3 px-5 pb-5 md:grid-cols-2">{visible.map((contact, index) => {
      const aliases = Array.from(new Set([string(contact.alias), ...strings(contact.aliases)].filter(Boolean))), name = aliases[0] || string(contact.contact_id, "未命名联系人"), urn = string(contact.urn);
      return <article key={string(contact.contact_id, urn || String(index))} className="flex min-w-0 items-start gap-3 rounded-2xl border p-4 transition-colors hover:bg-muted/25"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-base font-semibold text-primary">{Array.from(name)[0]}</div><div className="min-w-0 flex-1"><h3 className="truncate font-medium">{name}</h3>{aliases.length > 1 && <p className="mt-1 truncate text-xs text-muted-foreground">{aliases.slice(1).join(" · ")}</p>}<p className="mt-2 break-all font-mono text-[11px] leading-5 text-muted-foreground">{urn}</p></div>{urn && <CopyValue value={urn} label={`复制 ${name} 的 URN`} compact />}</article>;
    })}</div>}
    <RawSnapshot data={data} />
  </>;
}

function ReadableDetail({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5"><dt className="w-14 shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 flex-1 break-words">{value}</dd></div>;
}

export function TasksSnapshot({ data }: { data: RemoteRecord }) {
  const tasks = records(data.tasks), approvals = records(data.pending_confirmations), operations = records(data.operations);
  return <>
    {!!approvals.length && <section className="mx-5 mb-5 rounded-2xl border border-amber-200/80 bg-amber-50/50 p-4"><div className="flex items-start gap-3"><ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" /><div><h3 className="text-sm font-semibold text-amber-950">{approvals.length} 项需要你确认</h3><p className="mt-1 text-xs leading-5 text-amber-800">请回到 agent 的原生渠道核对并回应。</p></div></div><div className="mt-3 divide-y divide-amber-200/60">{approvals.map((approval, index) => <details key={string(approval.approval_id, String(index))} className="py-3"><summary className="cursor-pointer text-sm">{string(approval.subject_id, "待确认请求")}<span className="ml-2 text-xs text-amber-800">{stateLabel(approval.status)}</span></summary><p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">{string(approval.question)}</p><p className="mt-2 text-xs text-muted-foreground">截止时间：{displayTime(approval.expires_at) || "未提供"}</p></details>)}</div></section>}
    {!tasks.length && !approvals.length && !operations.length && <EmptySnapshot kind="tasks" />}
    <div className="space-y-3 px-5 pb-5">{tasks.map((task, index) => {
      const scope = record(task.scope), id = string(task.task_id, String(index));
      return <article key={id} className="rounded-2xl border p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-medium">{string(scope.purpose, id)}</h3><p className="mt-1 break-all text-xs text-muted-foreground">{id}</p></div><StatusBadge value={task.status} /></div><dl className="mt-4 space-y-1.5"><ReadableDetail label="主题" value={string(scope.topic)} /><ReadableDetail label="参与者" value={strings(scope.participant_ids).join("、")} /><ReadableDetail label="接收者" value={strings(scope.recipient_ids).join("、")} /><ReadableDetail label="有效期至" value={displayTime(scope.expires_at)} /></dl>{operations.filter(operation => operation.task_id === task.task_id).map((operation, operationIndex) => <div key={string(operation.operation_id, String(operationIndex))} className="mt-3 rounded-xl bg-muted/50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{string(operation.operation_id, "协作动作")}</p><StatusBadge value={operation.status} /></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{string(operation.text)}</p>{operation.status === "accepted" && <p className="mt-2 text-xs text-muted-foreground">本机队列已接收；尚不代表对方同意或事项完成。</p>}</div>)}</article>;
    })}</div>
    <RawSnapshot data={data} />
  </>;
}

function messageText(value: unknown): { text: string; structured: boolean } {
  const text = string(value);
  try { const content = record(JSON.parse(text)); if (content.protocol === "agent-comm-collaboration/v1" && typeof content.text === "string") return { text: content.text, structured: true }; } catch { /* Most peer messages are plain text. */ }
  return { text, structured: false };
}

export function InboxSnapshot({ data }: { data: RemoteRecord }) {
  const messages = records(data.messages).slice().reverse();
  return <>
    {!messages.length ? <EmptySnapshot kind="inbox" /> : <div className="space-y-3 px-5 pb-5"><p className="mb-4 text-xs leading-5 text-muted-foreground">消息来自对端 agent，内容仍需核实；涉及你的授权，请在原生渠道确认。</p>{messages.map((message, index) => {
      const content = messageText(message.text);
      return <article key={string(message.message_id, String(index))} className="rounded-2xl border p-4"><div className="flex items-start gap-3"><span className="rounded-xl bg-muted p-2"><ArrowDownLeft className="h-4 w-4 text-muted-foreground" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-all text-xs font-medium">{string(message.sender_urn, "对端 agent")}</p><time className="shrink-0 text-[11px] text-muted-foreground">{displayTime(message.received_at)}</time></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">{content.text || "这条消息未提供文本内容。"}</p>{!!message.task_id && <p className="mt-3 break-all text-xs text-muted-foreground">事项 · {string(message.task_id)}</p>}{content.structured && <p className="mt-2 text-[11px] text-muted-foreground">协作提议 · 对端声明</p>}</div></div></article>;
    })}</div>}
    <RawSnapshot data={data} />
  </>;
}

