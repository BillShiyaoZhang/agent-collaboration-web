"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { records, RemoteRecord, string } from "@/lib/control/workbench-client";
import { contactsForSelection, peerCommunication } from "./collaboration-workflow-model";
import { useLocalTime } from "@/components/local-time";
import { ActionFeedback } from "./mutation-panels";
import type { Workbench } from "./use-workbench";
import type { MutationMethod } from "./use-workbench-mutations";

export function SocialFeedback({ workbench: w, method, subject }: { workbench: Workbench; method: MutationMethod; subject?: string }) {
  const action = w.mutations.actions.slice().sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)).find(item => item.call.method === method && (!subject || [item.call.params.request_id, item.call.params.message_id].includes(subject)));
  return action ? <ActionFeedback action={action} onRetry={() => void w.mutations.retry(action)} onRestart={w.mutations.canRestart(action) ? () => void w.mutations.restart(action) : undefined} onRefresh={() => void w.mutations.refresh()} retryDisabled={!w.mutations.canMutate(method)} /> : null;
}

export function FriendRequests({ workbench: w }: { workbench: Workbench }) {
  const displayTime = useLocalTime();
  const requests = records(w.snapshots["contacts.requests"]?.data.contact_requests ?? w.snapshots["contacts.requests"]?.data.requests);
  if (!requests.length) return null;
  const active = requests.filter(request => request.status === "pending");
  const history = requests.filter(request => request.status !== "pending");
  const renderRequest = (request: RemoteRecord) => {
    const id = string(request.request_id), incoming = request.direction === "incoming", pending = request.status === "pending";
    const action = w.mutations.actions.find(item => item.call.method === "contacts.respond" && item.call.params.request_id === id);
    const locked = action && ["sending", "uncertain", "succeeded"].includes(action.phase);
    return <article id={`subject-${id}`} key={id} className="rounded-xl bg-muted/40 p-3"><div className="flex flex-wrap justify-between gap-2 text-xs"><span>{incoming ? "收到的请求" : "发起的请求"} · {pending ? incoming ? "等待你处理" : "待投递或等待对方处理" : request.status === "accepted" ? "已建立通讯录连接" : "已拒绝"}</span><time className="text-muted-foreground">{displayTime(request.updated_at || request.created_at)}</time></div><p className="mt-2 break-all font-mono text-xs leading-6">{string(request.peer_urn)}</p>{incoming && pending && <div className="mt-3 flex gap-2"><Button size="sm" disabled={!w.mutations.ready || !w.mutations.canMutate("contacts.respond") || !!locked} onClick={() => void w.mutations.run("contacts.respond", { request_id: id, decision: "accept" })}>接受好友请求</Button><Button size="sm" variant="outline" disabled={!w.mutations.ready || !w.mutations.canMutate("contacts.respond") || !!locked} onClick={() => void w.mutations.run("contacts.respond", { request_id: id, decision: "reject" })}>拒绝</Button></div>}<SocialFeedback workbench={w} method="contacts.respond" subject={id} /></article>;
  };
  return <section className="mx-5 mb-5 rounded-2xl border p-4" aria-label="好友请求"><h3 className="text-sm font-medium">好友请求{active.length ? ` · ${active.length} 项进行中` : ""}</h3>{active.some(request => request.direction === "incoming") && <p className="mt-1 text-xs leading-6 text-muted-foreground">接受后建立通讯录连接，可互发普通消息；这不代表已核实对方现实身份或授予协作权限。</p>}{!!active.length && <div className="mt-3 space-y-3">{active.slice().reverse().map(renderRequest)}</div>}{!!history.length && <details className={active.length ? "mt-4 border-t pt-3" : "mt-3"}><summary className="inline-flex min-h-8 cursor-pointer items-center text-xs text-muted-foreground">已处理的请求 · {history.length} 条</summary><div className="mt-3 space-y-3">{history.slice().reverse().map(renderRequest)}</div></details>}</section>;
}

export function SendPeerMessage({ workbench: w, recipientUrn = "", compact = false }: { workbench: Workbench; recipientUrn?: string; compact?: boolean }) {
  const [open, setOpen] = useState(false), [recipient, setRecipient] = useState(recipientUrn), [text, setText] = useState(""), [error, setError] = useState("");
  const action = w.mutations.actions.slice().sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)).find(item => item.call.method === "messages.send" && item.call.params.recipient_urn === recipient.trim());
  const pending = !!action && ["sending", "uncertain"].includes(action.phase);
  const allowed = w.mutations.ready && w.mutations.canMutate("messages.send");
  const contacts = contactsForSelection(records(w.snapshots["contacts.list"]?.data.contacts ?? w.snapshots["collaboration.state"]?.data.contacts));
  useEffect(() => { if (recipientUrn) setRecipient(recipientUrn); }, [recipientUrn]);
  async function send(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!/^urn:[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(recipient.trim())) { setError("请输入对方完整 URN。"); return; }
    if (!text.trim() || new TextEncoder().encode(text.trim()).length > 24000) { setError("请填写消息，内容不能超过 24 KB。"); return; }
    await w.mutations.run("messages.send", { recipient_urn: recipient.trim(), text: text.trim(), message_id: `message-${crypto.randomUUID()}` });
  }
  const showForm = open || pending;
  return <section className={compact ? "mt-3" : "mx-5 mb-5 rounded-2xl border p-4"} aria-label="发送消息给好友">{!showForm ? <><Button size="sm" variant="outline" aria-expanded={false} onClick={() => setOpen(true)} disabled={!allowed}>{compact ? "回复" : "给好友发消息"}</Button>{action?.phase === "failed" && <ActionFeedback action={action} onRetry={() => void w.mutations.retry(action)} onRestart={w.mutations.canRestart(action) ? () => void w.mutations.restart(action) : undefined} onRefresh={() => void w.mutations.refresh()} retryDisabled={!allowed} />}</> : <><div className="flex items-center justify-between gap-2"><h3 className="text-sm font-medium">{compact ? "回复这位联系人" : "给好友发消息"}</h3><Button type="button" variant="ghost" size="sm" disabled={pending} onClick={() => setOpen(false)}>收起</Button></div><form className="mt-3 space-y-3" onSubmit={send}>{!recipientUrn && <><label className="block text-xs">选择联系人<select aria-label="消息接收联系人" className="mt-1 block min-h-11 w-full rounded-md border bg-background p-2 text-base" value={contacts.some(contact => contact.urn === recipient) ? recipient : ""} onChange={event => setRecipient(event.target.value)} disabled={pending || !allowed}><option value="">选择已连接的联系人</option>{contacts.map(contact => <option key={string(contact.contact_id)} value={string(contact.urn)}>{string(contact.label)} · {string(contact.urn)}</option>)}</select></label><details><summary className="min-h-8 cursor-pointer text-xs text-muted-foreground">高级：填写确切接收方 URN</summary><Input aria-label="消息接收方 URN" placeholder="好友的完整 URN" value={recipient} onChange={event => setRecipient(event.target.value)} disabled={pending || !allowed} /></details></>}{recipient && <p className="break-all text-xs leading-6 text-muted-foreground">由自己的 agent 发给 {contacts.find(contact => contact.urn === recipient)?.label || "这位联系人"}：{recipient}。通讯录称呼只用于本方识别；发送和对方已读分别核验。</p>}<Textarea aria-label="发送给好友的消息" placeholder="由你的本机 agent 发送，与让 agent 在对话中发消息效果相同。" value={text} onChange={event => setText(event.target.value)} disabled={pending || !allowed} rows={3} />{error && <p role="alert" className="text-xs text-destructive">{error}</p>}<Button size="sm" disabled={!allowed || pending || !text.trim()} type="submit">{pending ? "等待 agent 确认…" : "发送消息"}</Button></form>{!allowed && <p className="mt-2 text-xs text-muted-foreground">连接恢复且本机授权发送功能后可操作。</p>}{action && <ActionFeedback action={action} onRetry={() => void w.mutations.retry(action)} onRestart={w.mutations.canRestart(action) ? () => void w.mutations.restart(action) : undefined} onRefresh={() => void w.mutations.refresh()} retryDisabled={!allowed} />}</>}</section>;
}

export function MessageReadAction({ message, workbench: w }: { message: RemoteRecord; workbench: Workbench }) {
  const id = string(message.message_id), action = w.mutations.actions.find(item => item.call.method === "inbox.mark_read" && item.call.params.message_id === id);
  const pending = action && ["sending", "uncertain", "succeeded"].includes(action.phase);
  return <div className="mt-3"><div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{message.read === true ? "已读 · agent 已记录" : "未读"}</span>{message.read !== true && <Button size="sm" variant="outline" aria-label={`将消息 ${id} 标为已读并关闭提醒`} disabled={!w.mutations.ready || !w.mutations.canMutate("inbox.mark_read") || !!pending} onClick={() => void w.mutations.run("inbox.mark_read", { message_id: id })}>标为已读并关闭提醒</Button>}</div><SocialFeedback workbench={w} method="inbox.mark_read" subject={id} /></div>;
}

export function SentMessages({ workbench: w }: { workbench: Workbench }) {
  const displayTime = useLocalTime();
  const messages = records(w.snapshots["collaboration.state"]?.data.sent_messages);
  if (!messages.length) return null;
  return <details className="mx-5 mb-5 rounded-2xl border p-4" aria-label="已发送消息"><summary className="inline-flex min-h-8 cursor-pointer items-center text-sm font-medium">已发送消息 · {messages.length} 条</summary><div className="mt-3 space-y-3">{messages.slice().reverse().map(message => <article key={string(message.message_id)} className="rounded-xl bg-muted/40 p-3"><div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span className="break-all">发给 {string(message.recipient_urn)}</span><span>{message.status === "accepted" ? "本机已接收发送" : message.status === "queued" ? "等待投递" : string(message.status)}</span></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">{string(message.text)}</p><time className="mt-2 block text-xs text-muted-foreground">{displayTime(message.created_at)}</time></article>)}</div></details>;
}

export function PeerCommunicationLog({ workbench: w, recipientUrn }: { workbench: Workbench; recipientUrn: string }) {
  const displayTime = useLocalTime(), [seen, setSeen] = useState<string[]>([]), [syncing, setSyncing] = useState(false);
  const state = w.snapshots["collaboration.state"]?.data;
  const messages = peerCommunication(records(w.snapshots["inbox.list"]?.data.messages ?? state?.inbox), records(state?.sent_messages), recipientUrn);
  const unread = messages.filter(message => message.direction === "incoming" && message.read !== true && seen.includes(string(message.message_id)));
  const allowed = w.mutations.ready && w.mutations.canMutate("inbox.mark_read");
  if (!messages.length) return null;
  return <details className="mt-3 rounded-xl border p-3" onToggle={event => { if (event.currentTarget.open) setSeen(messages.filter(message => message.direction === "incoming").map(message => string(message.message_id))); }}>
    <summary className="inline-flex min-h-9 cursor-pointer items-center text-xs font-medium">与这位联系人的通信记录 · {messages.length} 条</summary>
    <p className="mt-2 text-xs leading-6 text-muted-foreground">覆盖本账户已保存的普通通信。打开记录仅更新本页阅读状态；不会自动授权，也不会自动写入 agent 已读。</p>
    {unread.length > 0 && <Button type="button" variant="outline" size="sm" className="mt-2 h-auto min-h-9 whitespace-normal" disabled={!allowed || syncing} onClick={async () => { setSyncing(true); try { for (const message of unread) await w.mutations.run("inbox.mark_read", { message_id: message.message_id }); } finally { setSyncing(false); } }}>同步这段已看记录的已读 · {unread.length} 条</Button>}
    <div className="mt-3 space-y-3">{messages.map(message => <article key={`${string(message.direction)}-${string(message.message_id)}`} className="rounded-xl bg-muted/40 p-3"><p className="text-xs leading-6 text-muted-foreground">{message.direction === "incoming" ? "对端 agent 来信 · 内容为对端声明" : "本方 agent 发送记录"} · {displayTime(message.received_at || message.created_at)}</p><p className="mt-1 whitespace-pre-wrap break-words text-xs leading-6">{string(message.text)}</p><p className="mt-1 text-xs leading-6 text-muted-foreground">{message.direction === "incoming" ? message.read === true ? "Agent 已记录已读" : seen.includes(string(message.message_id)) ? "本页已看，agent 已读尚未同步" : "尚未在本页打开" : message.status === "accepted" ? "本机已受理，尚不能证明对方已读" : message.status === "queued" ? "等待投递" : string(message.status, "结果未提供")}</p><details className="mt-1"><summary className="min-h-8 cursor-pointer text-xs text-muted-foreground">来源与确切标识</summary><p className="break-all text-xs leading-6">{string(message.message_id)}<br />{message.direction === "incoming" ? string(message.sender_urn) : string(message.recipient_urn)}</p></details></article>)}</div>
  </details>;
}
