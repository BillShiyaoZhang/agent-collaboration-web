"use client";

import { useState } from "react";
import { ArrowDownLeft, Check, ChevronDown, ClipboardList, Copy, Inbox, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { record, records, RemoteRecord, stateLabel, string, strings } from "@/lib/control/workbench-client";
import { useHydrated, useLocalTime } from "@/components/local-time";
import { CollaborationSnapshot } from "@/components/workbench/collaboration-snapshot";
import { MessageReadAction, SendPeerMessage } from "./social-panels";
import { ApprovalRequests } from "./mutation-panels";
import type { Workbench } from "./use-workbench";

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
  return <span className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${color}`}>{stateLabel(value)}</span>;
}

export function EmptySnapshot({ kind, filtered = false }: { kind: "contacts" | "tasks" | "inbox"; filtered?: boolean }) {
  const Icon = kind === "contacts" ? Users : kind === "tasks" ? ClipboardList : Inbox;
  const descriptions = {
    contacts: ["联系人会出现在这里", "添加并确认联系人后，会自动从 agent 同步到这里。"],
    tasks: ["暂时没有协作事项", "交给 agent 的协作事项和待确认请求，会在这里汇集。"],
    inbox: ["收件箱很安静", "来自其他 agent 的消息，会在这里显示。"],
  };
  return <div className="flex min-h-64 flex-col items-center justify-center px-6 py-12 text-center"><span className="mb-4 rounded-2xl bg-muted p-4"><Icon className="h-7 w-7 text-muted-foreground" strokeWidth={1.5} /></span><h3 className="font-medium">{filtered ? "没有匹配的结果" : descriptions[kind][0]}</h3><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{filtered ? "试试其他姓名、别名或 URN。" : descriptions[kind][1]}</p></div>;
}

export function RawSnapshot({ data }: { data: unknown }) {
  return <details className="group border-t px-5 py-3"><summary className="inline-flex min-h-6 w-fit cursor-pointer list-none items-center gap-1.5 rounded py-1 text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"><ChevronDown className="h-3.5 w-3.5 transition-transform group-open:rotate-180" />查看原始快照</summary><pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/60 p-4 text-xs leading-6">{JSON.stringify(data, null, 2)}</pre></details>;
}

function RetryRejectedContact({ contact, workbench: w }: { contact: RemoteRecord; workbench: Workbench }) {
  const [confirming, setConfirming] = useState(false);
  const contactId = string(contact.contact_id), urn = string(contact.urn), aliases = strings(contact.aliases);
  const action = w.mutations.contactAction;
  const sameAction = action?.call.params.contact_id === contactId && action.call.params.urn === urn;
  const busy = !!action && ["sending", "uncertain"].includes(action.phase);
  const requests = records(w.snapshots["contacts.requests"]?.data.contact_requests ?? w.snapshots["contacts.requests"]?.data.requests);
  const submittedRequest = sameAction && action?.phase === "succeeded" ? string(action.result?.request_id) : "";
  const awaitingSync = !!sameAction && action?.phase === "succeeded" &&
    (!submittedRequest || !requests.some(request => request.request_id === submittedRequest && request.status === "rejected"));
  const allowed = w.canAddContact && w.mutations.ready && !busy && !awaitingSync && !!contactId && !!urn && !!aliases.length;

  return <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50/50 p-3 text-xs leading-6">
    <p>上次好友请求已被拒绝。重新发起会沿用这条本机联系人记录，由 Agent 核对最新状态；若仍无在途请求且尚未连接，才会生成一条独立的新请求。旧请求仍保留“已拒绝”。</p>
    {awaitingSync && <p role="status" className="mt-1">Agent 已返回当前处理结果，等待联系人和好友请求状态同步。</p>}
    {sameAction && action?.phase === "failed" && <p role="alert" className="mt-1">{action.message}</p>}
    {confirming ? <div className="mt-2 space-y-2">
      <p>请再次核对对方 URN：<span className="block break-all font-mono">{urn}</span></p>
      <div className="flex flex-wrap gap-2"><Button type="button" size="sm" disabled={!allowed} onClick={() => {
        void w.mutations.addContact({ contact_id: contactId, aliases, urn }); setConfirming(false);
      }}>确认并重新发起</Button><Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>取消</Button></div>
    </div> : <Button type="button" size="sm" variant="outline" className="mt-2" disabled={!allowed} onClick={() => setConfirming(true)}>重新发起好友请求</Button>}
  </div>;
}

export function ContactsSnapshot({ data, workbench, syncedAt }: { data: RemoteRecord; workbench: Workbench; syncedAt: number }) {
  const hydrated = useHydrated();
  const [query, setQuery] = useState("");
  const contacts = records(data.contacts);
  const visible = contacts.filter(contact => [string(contact.contact_id), string(contact.urn), string(contact.alias), ...strings(contact.aliases)].join(" ").toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  return <>
    {!!contacts.length && <div className="px-5 pb-4"><div className="relative max-w-sm"><Search aria-hidden className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input aria-label="搜索联系人" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索姓名、别名或 URN" className="rounded-xl bg-muted/40 pl-9" /></div></div>}
    {!visible.length ? <EmptySnapshot kind="contacts" filtered={!!query} /> : <div className="grid gap-3 px-3 pb-5 sm:px-5 md:grid-cols-2">{visible.map((contact, index) => {
      const aliases = Array.from(new Set([string(contact.alias), ...strings(contact.aliases)].filter(Boolean))), name = aliases[0] || string(contact.contact_id, "未命名联系人"), urn = string(contact.urn);
      const presence = record(contact.presence), status = string(contact.connection_status, "unverified");
      const connected = status === "connected", expiry = typeof presence.expires_at === "number" ? presence.expires_at * 1000 : Date.parse(string(presence.expires_at));
      const freshPresence = hydrated && connected && (presence.status === "online" ? Number.isFinite(expiry) && expiry > Date.now() : Date.now() - syncedAt < 60000);
      const online = freshPresence && presence.status === "online";
      return <article key={string(contact.contact_id, urn || String(index))} className="flex min-w-0 flex-col items-start gap-3 rounded-2xl border p-3 transition-colors hover:bg-muted/25 sm:flex-row sm:p-4"><div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-base font-semibold text-primary">{Array.from(name)[0]}</div><div className="min-w-0 flex-1"><h3 className="break-words font-medium sm:truncate">{name}</h3><p className="mt-1 text-xs text-muted-foreground">{connected ? "已建立通讯录连接" : status === "pending" ? "请求待投递或待对方处理" : status === "rejected" ? "好友请求已拒绝" : "尚未建立通讯录连接"}{connected && <span className={online ? "ml-2 text-emerald-700" : "ml-2"}>● {online ? "在线" : freshPresence && presence.status === "offline" ? "离线" : "在线状态待更新"}</span>}</p>{aliases.length > 1 && <p className="mt-1 truncate text-xs text-muted-foreground">{aliases.slice(1).join(" · ")}</p>}<p className="mt-2 break-all font-mono text-xs leading-5 text-muted-foreground">{urn}</p>{status === "rejected" && <RetryRejectedContact contact={contact} workbench={workbench} />}{connected && <SendPeerMessage workbench={workbench} recipientUrn={urn} compact />}</div>{urn && <CopyValue value={urn} label={`复制 ${name} 的 URN`} compact />}</article>;
    })}</div>}
    <RawSnapshot data={data} />
  </>;
}

function ReadableDetail({ label, value }: { label: string; value: string }) {
  if (!value) return null;
  return <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs leading-5"><dt className="w-14 shrink-0 text-muted-foreground">{label}</dt><dd className="min-w-0 flex-1 break-words">{value}</dd></div>;
}

export function TasksSnapshot({ data, workbench }: { data: RemoteRecord; workbench: Workbench }) {
  const displayTime = useLocalTime();
  const tasks = records(data.tasks), approvals = records(data.pending_confirmations), operations = records(data.operations);
  return <>
    <CollaborationSnapshot data={data} />
    <ApprovalRequests approvals={approvals} workbench={workbench} />
    {!tasks.length && !approvals.length && !operations.length && !records(data.collaborations).length && !records(record(data.collaboration ?? data.collaboration_v2).collaborations).length && !records(data.invitations).length && !records(record(data.collaboration ?? data.collaboration_v2).invitations).length && <EmptySnapshot kind="tasks" />}
    <div className="space-y-3 px-5 pb-5">{tasks.map((task, index) => {
      const scope = record(task.scope), id = string(task.task_id, String(index));
      return <article id={`subject-${id}`} key={id} className="rounded-2xl border p-4"><div className="flex items-start justify-between gap-3"><div className="min-w-0"><h3 className="break-words font-medium">{string(scope.purpose, id)}</h3><p className="mt-1 break-all text-xs text-muted-foreground">{id}</p></div><StatusBadge value={task.status} /></div><dl className="mt-4 space-y-1.5"><ReadableDetail label="主题" value={string(scope.topic)} /><ReadableDetail label="参与者" value={strings(scope.participant_ids).join("、")} /><ReadableDetail label="接收者" value={strings(scope.recipient_ids).join("、")} /><ReadableDetail label="有效期至" value={displayTime(scope.expires_at)} /></dl>{operations.filter(operation => operation.task_id === task.task_id).map((operation, operationIndex) => <div key={string(operation.operation_id, String(operationIndex))} className="mt-3 rounded-xl bg-muted/50 p-3"><div className="flex flex-wrap items-center justify-between gap-2"><p className="text-xs text-muted-foreground">{string(operation.operation_id, "协作动作")}</p><StatusBadge value={operation.status} /></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">{string(operation.text)}</p>{operation.status === "accepted" && <p className="mt-2 text-xs text-muted-foreground">本机队列已接收；尚不代表对方同意或事项完成。</p>}</div>)}</article>;
    })}</div>
    <RawSnapshot data={data} />
  </>;
}

function messageText(value: unknown): { text: string; structured: boolean } {
  const text = string(value);
  try { const content = record(JSON.parse(text)); if (content.protocol === "agent-comm-collaboration/v1" && typeof content.text === "string") return { text: content.text, structured: true }; } catch { /* Most peer messages are plain text. */ }
  return { text, structured: false };
}

export function InboxSnapshot({ data, workbench }: { data: RemoteRecord; workbench: Workbench }) {
  const displayTime = useLocalTime();
  const messages = records(data.messages).slice().reverse();
  return <>
    {!messages.length ? <EmptySnapshot kind="inbox" /> : <div className="space-y-3 px-5 pb-5"><p className="mb-4 text-xs leading-5 text-muted-foreground">消息来自对端 agent，内容仍需核实；涉及你的授权，可在「事项」中核对并确认。</p>{messages.map((message, index) => {
      const content = messageText(message.text), messageId = string(message.message_id);
      return <article id={`subject-${messageId}`} key={string(message.message_id, String(index))} className="rounded-2xl border p-4"><div className="flex items-start gap-3"><span className="rounded-xl bg-muted p-2"><ArrowDownLeft className="h-4 w-4 text-muted-foreground" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center justify-between gap-2"><p className="min-w-0 break-all text-xs font-medium">{string(message.sender_urn, "对端 agent")}</p><time className="shrink-0 text-xs text-muted-foreground">{displayTime(message.received_at)}</time></div><div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-muted-foreground"><span className="min-w-0 break-all font-mono">消息 ID · {messageId}</span>{messageId && <CopyValue value={messageId} label={`复制消息 ID ${messageId}`} compact />}</div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">{content.text || "这条消息未提供文本内容。"}</p>{message.unknown_sender === true && <p className="mt-2 text-xs text-amber-800">这位发送者尚未建立好友连接。</p>}<MessageReadAction message={message} workbench={workbench} />{message.unknown_sender !== true && <SendPeerMessage workbench={workbench} recipientUrn={string(message.sender_urn)} compact />}{!!message.task_id && <p className="mt-3 break-all text-xs text-muted-foreground">事项 · {string(message.task_id)}</p>}{content.structured && <p className="mt-2 text-xs text-muted-foreground">协作提议 · 对端声明</p>}</div></div></article>;
    })}</div>}
    <RawSnapshot data={data} />
  </>;
}
