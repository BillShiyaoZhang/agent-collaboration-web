"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { displayTime, records, RemoteRecord, string } from "@/lib/control/workbench-client";
import { ActionFeedback } from "./mutation-panels";
import type { Workbench } from "./use-workbench";
import type { MutationMethod } from "./use-workbench-mutations";

export function SocialFeedback({ workbench: w, method, subject }: { workbench: Workbench; method: MutationMethod; subject?: string }) {
  const action = w.mutations.actions.slice().reverse().find(item => item.call.method === method && (!subject || [item.call.params.request_id, item.call.params.message_id].includes(subject)));
  return action ? <ActionFeedback action={action} onRetry={() => void w.mutations.retry(action)} onRestart={() => void w.mutations.restart(action)} onRefresh={() => void w.mutations.refresh()} retryDisabled={!w.mutations.canMutate(method)} /> : null;
}

export function FriendRequests({ workbench: w }: { workbench: Workbench }) {
  const requests = records(w.snapshots["contacts.requests"]?.data.contact_requests ?? w.snapshots["contacts.requests"]?.data.requests);
  if (!requests.length) return null;
  return <section className="mx-5 mb-5 rounded-2xl border p-4" aria-label="好友请求"><h3 className="text-sm font-medium">好友请求</h3><p className="mt-1 text-xs leading-6 text-muted-foreground">接受后建立通讯录连接，可互发普通消息；这不代表已核实对方现实身份或授予协作权限。</p><div className="mt-3 space-y-3">{requests.slice().reverse().map(request => {
    const id = string(request.request_id), incoming = request.direction === "incoming", pending = request.status === "pending";
    const action = w.mutations.actions.find(item => item.call.method === "contacts.respond" && item.call.params.request_id === id);
    const locked = action && ["sending", "uncertain", "succeeded"].includes(action.phase);
    return <article id={`subject-${id}`} key={id} className="rounded-xl bg-muted/40 p-3"><div className="flex flex-wrap justify-between gap-2 text-xs"><span>{incoming ? "收到的请求" : "发起的请求"} · {pending ? incoming ? "等待你处理" : "待投递或等待对方处理" : request.status === "accepted" ? "已建立通讯录连接" : "已拒绝"}</span><time className="text-muted-foreground">{displayTime(request.updated_at || request.created_at)}</time></div><p className="mt-2 break-all font-mono text-xs leading-6">{string(request.peer_urn)}</p>{incoming && pending && <div className="mt-3 flex gap-2"><Button size="sm" disabled={!w.mutations.ready || !w.mutations.canMutate("contacts.respond") || !!locked} onClick={() => void w.mutations.run("contacts.respond", { request_id: id, decision: "accept" })}>接受好友请求</Button><Button size="sm" variant="outline" disabled={!w.mutations.ready || !w.mutations.canMutate("contacts.respond") || !!locked} onClick={() => void w.mutations.run("contacts.respond", { request_id: id, decision: "reject" })}>拒绝</Button></div>}<SocialFeedback workbench={w} method="contacts.respond" subject={id} /></article>;
  })}</div></section>;
}

export function SendPeerMessage({ workbench: w, recipientUrn = "", compact = false }: { workbench: Workbench; recipientUrn?: string; compact?: boolean }) {
  const [open, setOpen] = useState(!compact), [recipient, setRecipient] = useState(recipientUrn), [text, setText] = useState(""), [error, setError] = useState("");
  const action = w.mutations.actions.slice().reverse().find(item => item.call.method === "messages.send" && item.call.params.recipient_urn === recipient.trim());
  const pending = !!action && ["sending", "uncertain"].includes(action.phase);
  const allowed = w.mutations.ready && w.mutations.canMutate("messages.send");
  async function send(event: React.FormEvent) {
    event.preventDefault(); setError("");
    if (!/^urn:[A-Za-z0-9][A-Za-z0-9._:-]*:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(recipient.trim())) { setError("请输入对方完整 URN。"); return; }
    if (!text.trim() || new TextEncoder().encode(text.trim()).length > 24000) { setError("请填写消息，内容不能超过 24 KB。"); return; }
    await w.mutations.run("messages.send", { recipient_urn: recipient.trim(), text: text.trim(), message_id: `message-${crypto.randomUUID()}` });
  }
  return <section className={compact ? "mt-3" : "mx-5 mb-5 rounded-2xl border p-4"} aria-label="发送消息给好友">{compact && !open ? <Button size="sm" variant="outline" onClick={() => setOpen(true)} disabled={!allowed}>回复</Button> : <><h3 className="text-sm font-medium">{compact ? "回复这位联系人" : "给好友发消息"}</h3><form className="mt-3 space-y-3" onSubmit={send}>{!recipientUrn && <Input aria-label="消息接收方 URN" placeholder="好友的完整 URN" value={recipient} onChange={event => setRecipient(event.target.value)} disabled={pending || !allowed} />}<Textarea aria-label="发送给好友的消息" placeholder="由你的本机 agent 发送，与让 agent 在对话中发消息效果相同。" value={text} onChange={event => setText(event.target.value)} disabled={pending || !allowed} rows={3} />{error && <p role="alert" className="text-xs text-destructive">{error}</p>}<Button size="sm" disabled={!allowed || pending || !text.trim()} type="submit">{pending ? "等待 agent 确认…" : "发送消息"}</Button></form>{!allowed && <p className="mt-2 text-xs text-muted-foreground">连接恢复且本机授权发送功能后可操作。</p>}{action && <ActionFeedback action={action} onRetry={() => void w.mutations.retry(action)} onRestart={() => void w.mutations.restart(action)} onRefresh={() => void w.mutations.refresh()} retryDisabled={!allowed} />}</>}</section>;
}

export function MessageReadAction({ message, workbench: w }: { message: RemoteRecord; workbench: Workbench }) {
  const id = string(message.message_id), action = w.mutations.actions.find(item => item.call.method === "inbox.mark_read" && item.call.params.message_id === id);
  const pending = action && ["sending", "uncertain", "succeeded"].includes(action.phase);
  return <div className="mt-3"><div className="flex items-center gap-3"><span className="text-xs text-muted-foreground">{message.read === true ? "已读 · agent 已记录" : "未读"}</span>{message.read !== true && <Button size="sm" variant="outline" aria-label={`将消息 ${id} 标为已读并关闭提醒`} disabled={!w.mutations.ready || !w.mutations.canMutate("inbox.mark_read") || !!pending} onClick={() => void w.mutations.run("inbox.mark_read", { message_id: id })}>标为已读并关闭提醒</Button>}</div><SocialFeedback workbench={w} method="inbox.mark_read" subject={id} /></div>;
}

export function SentMessages({ workbench: w }: { workbench: Workbench }) {
  const messages = records(w.snapshots["collaboration.state"]?.data.sent_messages);
  if (!messages.length) return null;
  return <section className="mx-5 mb-5 rounded-2xl border p-4" aria-label="已发送消息"><h3 className="text-sm font-medium">已发送消息</h3><div className="mt-3 space-y-3">{messages.slice().reverse().map(message => <article key={string(message.message_id)} className="rounded-xl bg-muted/40 p-3"><div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground"><span className="break-all">发给 {string(message.recipient_urn)}</span><span>{message.status === "accepted" ? "本机已接收发送" : message.status === "queued" ? "等待投递" : string(message.status)}</span></div><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7">{string(message.text)}</p><time className="mt-2 block text-xs text-muted-foreground">{displayTime(message.created_at)}</time></article>)}</div></section>;
}
