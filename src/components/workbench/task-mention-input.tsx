"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/shared/utils";
import { string, type RemoteRecord } from "@/lib/control/workbench-client";
import type { Workbench } from "./use-workbench";

type Trigger = { start: number; end: number; query: string };

export function taskMentionTrigger(value: string, caret: number): Trigger | null {
  const before = value.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(before);
  if (!match) return null;
  return { start: caret - match[1].length - 1, end: caret, query: match[1] };
}

export function removeTaskMentionTrigger(value: string, trigger: Trigger): string {
  return value.slice(0, trigger.start) + value.slice(trigger.end);
}

export function taskMentionSearchQuery(trigger: Trigger | null): string {
  return trigger?.query.slice(0, 120) || "";
}

export function TaskMentionInput({ workbench: w, desktop, onSend }: { workbench: Workbench; desktop: boolean; onSend: () => void }) {
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [items, setItems] = useState<RemoteRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const [retry, setRetry] = useState(0);
  const requested = useRef<string | null>(null);
  const currentQuery = useRef("");
  const invoke = useRef(w.invoke); invoke.current = w.invoke;
  const query = taskMentionSearchQuery(trigger);
  currentQuery.current = query;
  const menuOpen = !!trigger;
  const busy = !!w.busy["task.list"];
  const policyBlocked = !w.policyAllowed;
  const pairingNeeded = w.sync.status === "needs_pairing";
  const offline = w.sync.status === "offline";
  const canSearchTasks = w.canMentionTasks && !pairingNeeded && !offline;
  useEffect(() => {
    if (!menuOpen || !canSearchTasks) { requested.current = null; return; }
    if (busy || requested.current === query) return;
    const timer = setTimeout(() => {
      requested.current = query; setLoading(true); setError("");
      void invoke.current("task.list", { query, limit: 20 }).then(outcome => {
        if (currentQuery.current !== query) return;
        if (outcome.result) { setItems(Array.isArray(outcome.result.items) ? outcome.result.items as RemoteRecord[] : []); setActive(0); }
        else setError(outcome.error?.message || "暂时无法搜索事项。");
      }).finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [menuOpen, query, busy, canSearchTasks, retry]);
  const choices = items.filter(item => !w.taskMentions.some(mention => mention.taskId === item.task_id));
  function pick(item: RemoteRecord) {
    if (!trigger) return;
    const id = string(item.task_id);
    if (!id) return;
    w.addTaskMention(id, string(item.topic, string(item.purpose, id)));
    w.setText(removeTaskMentionTrigger(w.text, trigger));
    setTrigger(null); setItems([]); requested.current = null;
    requestAnimationFrame(() => w.composer.current?.focus());
  }
  const disabled = !w.canSend || !!w.submission || w.selectingConversation;
  return <div className="conversation-composer-box relative rounded-2xl border bg-card p-3 transition-shadow focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/10">
    {!!w.taskMentions.length && <div role="group" aria-label="本条消息提及的合作事项" className="mb-2 flex flex-wrap gap-2">{w.taskMentions.map(item => <span key={item.taskId} className="inline-flex min-w-0 items-center gap-1 rounded-full border border-primary/20 bg-primary/5 px-2.5 py-1 text-xs text-primary"><span className="max-w-48 truncate">@{item.title}</span><Button type="button" size="icon" variant="ghost" className="h-6 w-6 rounded-full" aria-label={`移除事项 ${item.title}`} disabled={disabled} onClick={() => w.removeTaskMention(item.taskId)}><X className="h-3 w-3" /></Button></span>)}</div>}
    <Textarea ref={w.composer} aria-label="给 agent 的消息" aria-autocomplete={canSearchTasks ? "list" : undefined} aria-expanded={menuOpen} aria-controls={menuOpen ? "task-mention-options" : undefined} aria-activedescendant={menuOpen && canSearchTasks && choices[active] ? `task-mention-${string(choices[active].task_id)}` : undefined} maxLength={8000} value={w.text} disabled={disabled} onChange={event => { w.setText(event.target.value); setTrigger(taskMentionTrigger(event.target.value, event.target.selectionStart)); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; }} onKeyDown={event => {
      if (event.key === "Escape" && menuOpen) { event.preventDefault(); setTrigger(null); return; }
      if (menuOpen && canSearchTasks && !error && !loading && choices.length && event.key === "ArrowDown") { event.preventDefault(); setActive(index => (index + 1) % choices.length); return; }
      if (menuOpen && canSearchTasks && !error && !loading && choices.length && event.key === "ArrowUp") { event.preventDefault(); setActive(index => (index + choices.length - 1) % choices.length); return; }
      if (menuOpen && canSearchTasks && !error && !loading && choices[active] && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) { event.preventDefault(); pick(choices[active]); return; }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!menuOpen || !canSearchTasks) onSend(); }
    }} placeholder={w.canSend ? "告诉 agent 你想做什么… 输入 @ 选择合作事项" : "连接与授权恢复后可发送消息"} className={cn("resize-none rounded-none border-0 bg-transparent p-1 text-base shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-60", desktop ? "min-h-14" : "min-h-20")} />
    {menuOpen && <div id="task-mention-options" role={canSearchTasks && !error ? "listbox" : "group"} aria-label={canSearchTasks && !error ? "选择合作事项" : "事项引用暂不可用"} className="absolute bottom-full left-2 right-2 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border bg-card p-1 shadow-lg">
      {!canSearchTasks ? <div className="space-y-2 p-3 text-xs leading-5 text-muted-foreground">
        <p role="status">{policyBlocked ? "当前账户的远程控制已暂停，事项引用暂不可用。" : pairingNeeded ? "此 Agent 的本机配对需要恢复，事项引用暂不可用。" : offline ? "此 Agent 暂未连上，事项引用需等连接恢复。" : !w.capabilitySnapshot ? "尚未确认此 Agent 是否支持事项引用，请先检查连接。" : "当前连接暂不能搜索或读取事项详情，输入的 @ 不会创建事项引用。"}</p>
        {policyBlocked ? <p>请在页面顶部的“平台政策与内容可见范围”中确认或恢复使用。</p> : <><p>{pairingNeeded ? "请到连接设置核对原控制台、配对范围和期限。" : offline ? "请检查 Hermes 原设备、Gateway 与 helper 的运行状态。" : w.capabilitySnapshot ? "可能需要在 Hermes 原设备为当前控制台重新配对，或升级旧接入组件。网页不能自行增加权限。" : "连接检查会读取当前 Agent 的实际能力和配对状态，不会修改授权。"}{w.canSend && !offline && " 普通对话仍可发送。"}</p><Link className="inline-flex min-h-9 items-center font-medium text-primary underline underline-offset-4 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" href={`/dashboard/connections?agent=${encodeURIComponent(w.agentId)}&guide=task-mentions`}>{w.capabilitySnapshot || pairingNeeded ? "查看此 Agent 的授权步骤" : "打开此 Agent 的连接设置"}</Link></>}
      </div> : w.taskMentions.length >= 8 ? <p className="p-3 text-xs text-muted-foreground">一条消息最多提及 8 个事项。</p> : loading || busy ? <p role="status" className="p-3 text-xs text-muted-foreground">正在搜索事项…</p> : error ? <div className="space-y-2 p-2 text-xs"><p role="alert">{error}</p><Button size="sm" variant="ghost" onClick={() => { requested.current = null; setError(""); setRetry(value => value + 1); }}>重试搜索</Button><Link className="inline-flex min-h-9 items-center font-medium text-primary underline underline-offset-4" href={`/dashboard/connections?agent=${encodeURIComponent(w.agentId)}&guide=task-mentions`}>检查连接与授权</Link></div> : choices.length ? choices.map((item, index) => <button key={string(item.task_id)} id={`task-mention-${string(item.task_id)}`} type="button" role="option" aria-selected={index === active} onMouseDown={event => event.preventDefault()} onClick={() => pick(item)} className={cn("flex min-h-11 w-full flex-col rounded-lg px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", index === active && "bg-muted")}><span className="break-words font-medium">{string(item.topic, string(item.purpose, string(item.task_id)))}</span><span className="break-all text-xs text-muted-foreground">{string(item.status, "状态待核对")} · {string(item.task_id)}</span></button>) : <p className="p-3 text-xs text-muted-foreground">没有匹配的可引用事项。</p>}
    </div>}
    <div className="mt-2 flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground"><span className="hidden sm:inline">Ctrl / ⌘ + Enter 发送</span><span className="sm:hidden">换行可继续输入</span>{w.text.length > 7000 && <span className="ml-2">{w.text.length} / 8000</span>}</p><Button aria-label="发送消息" disabled={disabled || !w.text.trim() || !!w.busy["conversation.send"] || menuOpen && canSearchTasks} onClick={onSend} className="min-h-10 gap-1.5 rounded-full px-4">{w.busy["conversation.send"] ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}发送</Button></div>
  </div>;
}
