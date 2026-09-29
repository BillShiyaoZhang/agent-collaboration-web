"use client";

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
  useEffect(() => {
    if (!menuOpen) { requested.current = null; return; }
    if (!w.canMentionTasks || busy || requested.current === query) return;
    const timer = setTimeout(() => {
      requested.current = query; setLoading(true); setError("");
      void invoke.current("task.list", { query, limit: 20 }).then(outcome => {
        if (currentQuery.current !== query) return;
        if (outcome.result) { setItems(Array.isArray(outcome.result.items) ? outcome.result.items as RemoteRecord[] : []); setActive(0); }
        else setError(outcome.error?.message || "暂时无法搜索事项。");
      }).finally(() => setLoading(false));
    }, 180);
    return () => clearTimeout(timer);
  }, [menuOpen, query, busy, w.canMentionTasks, retry]);
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
    <Textarea ref={w.composer} aria-label="给 agent 的消息" aria-autocomplete={w.canMentionTasks ? "list" : undefined} aria-expanded={menuOpen} aria-controls={menuOpen ? "task-mention-options" : undefined} aria-activedescendant={menuOpen && choices[active] ? `task-mention-${string(choices[active].task_id)}` : undefined} maxLength={8000} value={w.text} disabled={disabled} onChange={event => { w.setText(event.target.value); setTrigger(taskMentionTrigger(event.target.value, event.target.selectionStart)); event.target.style.height = "auto"; event.target.style.height = `${Math.min(event.target.scrollHeight, 180)}px`; }} onKeyDown={event => {
      if (event.key === "Escape" && menuOpen) { event.preventDefault(); setTrigger(null); return; }
      if (menuOpen && choices.length && event.key === "ArrowDown") { event.preventDefault(); setActive(index => (index + 1) % choices.length); return; }
      if (menuOpen && choices.length && event.key === "ArrowUp") { event.preventDefault(); setActive(index => (index + choices.length - 1) % choices.length); return; }
      if (menuOpen && choices[active] && event.key === "Enter" && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.nativeEvent.isComposing) { event.preventDefault(); pick(choices[active]); return; }
      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (!menuOpen || !w.canMentionTasks) onSend(); }
    }} placeholder={w.canSend ? "告诉 agent 你想做什么… 输入 @ 选择合作事项" : "连接与授权恢复后可发送消息"} className={cn("resize-none rounded-none border-0 bg-transparent p-1 text-base shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-60", desktop ? "min-h-14" : "min-h-20")} />
    {menuOpen && <div id="task-mention-options" role="listbox" aria-label="选择合作事项" className="absolute bottom-full left-2 right-2 z-20 mb-2 max-h-64 overflow-y-auto rounded-xl border bg-card p-1 shadow-lg">
      {!w.canMentionTasks ? <p role="status" className="p-3 text-xs leading-5 text-muted-foreground">当前 Agent 未开放事项搜索和详情权限。可以继续普通对话；此处不会创建结构化事项引用。</p> : w.taskMentions.length >= 8 ? <p className="p-3 text-xs text-muted-foreground">一条消息最多提及 8 个事项。</p> : loading || busy ? <p role="status" className="p-3 text-xs text-muted-foreground">正在搜索事项…</p> : error ? <div className="p-2 text-xs"><p role="alert">{error}</p><Button size="sm" variant="ghost" onClick={() => { requested.current = null; setError(""); setRetry(value => value + 1); }}>重试搜索</Button></div> : choices.length ? choices.map((item, index) => <button key={string(item.task_id)} id={`task-mention-${string(item.task_id)}`} type="button" role="option" aria-selected={index === active} onMouseDown={event => event.preventDefault()} onClick={() => pick(item)} className={cn("flex min-h-11 w-full flex-col rounded-lg px-3 py-2 text-left text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", index === active && "bg-muted")}><span className="break-words font-medium">{string(item.topic, string(item.purpose, string(item.task_id)))}</span><span className="break-all text-xs text-muted-foreground">{string(item.status, "状态待核对")} · {string(item.task_id)}</span></button>) : <p className="p-3 text-xs text-muted-foreground">没有匹配的可引用事项。</p>}
    </div>}
    <div className="mt-2 flex items-center justify-between gap-3"><p className="text-xs text-muted-foreground"><span className="hidden sm:inline">Ctrl / ⌘ + Enter 发送</span><span className="sm:hidden">换行可继续输入</span>{w.text.length > 7000 && <span className="ml-2">{w.text.length} / 8000</span>}</p><Button aria-label="发送消息" disabled={disabled || !w.text.trim() || !!w.busy["conversation.send"] || menuOpen && w.canMentionTasks} onClick={onSend} className="min-h-10 gap-1.5 rounded-full px-4">{w.busy["conversation.send"] ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp className="h-4 w-4" />}发送</Button></div>
  </div>;
}
