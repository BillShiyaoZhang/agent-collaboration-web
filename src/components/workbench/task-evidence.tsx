"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { useLocalTime } from "@/components/local-time";
import { record, records, string, type RemoteRecord } from "@/lib/control/workbench-client";
import type { Workbench } from "./use-workbench";

type Depth = "overview" | "progress" | "records";
const tabs: { id: Depth; title: string }[] = [{ id: "overview", title: "概览" }, { id: "progress", title: "进展" }, { id: "records", title: "记录" }];

function Coverage({ value, events, hasMore }: { value: RemoteRecord; events: RemoteRecord[]; hasMore: boolean }) {
  const displayTime = useLocalTime();
  return <div className="space-y-1 text-xs leading-5 text-muted-foreground">
    <p>{value.complete === true ? "本方 Agent 将可读取的留存历史标记为完整。" : value.journal === "local_transitions_since_upgrade" ? "本方事件账本覆盖升级后的本地状态变化；更早变化无法回放。" : "这里只列出本方获准读取且实际留存的记录，可能有历史缺口。"}{Object.values(record(value.truncated)).some(Boolean) ? " 当前快照有裁剪，请按事件分页核对。" : ""} 对端私有过程不在本方记录中。</p>
    {!!events.length && <p>当前已加载事件的时间范围：{displayTime(events[0].at) || "时间未提供"} 至 {displayTime(events[events.length - 1].at) || "时间未提供"}。{hasMore ? "还有后续分页。" : "已到最后一页。"}</p>}
  </div>;
}

function EventRow({ event, detailed, agentId }: { event: RemoteRecord; detailed: boolean; agentId: string }) {
  const displayTime = useLocalTime();
  const source = record(event.source_context), conversationId = string(source.conversation_id);
  return <li className="min-w-0 rounded-xl border bg-background p-3 text-xs leading-6"><div className="flex flex-wrap items-baseline justify-between gap-2"><p className="font-medium">{string(event.summary, string(event.kind, "记录"))}</p><time className="text-muted-foreground">{displayTime(event.at) || "时间未提供"}</time></div>
    <p className="text-muted-foreground">来源：{string(event.source, "本方 Agent 留存记录")} · {string(event.kind, "类型未提供")}</p>
    {conversationId && <Link className="text-primary underline underline-offset-4" href={`/dashboard/chats?agent=${encodeURIComponent(agentId)}&conversation=${encodeURIComponent(conversationId)}${source.turn_id ? `&turn=${encodeURIComponent(string(source.turn_id))}` : ""}`}>查看相关对话</Link>}
    {detailed && <details className="mt-2"><summary className="min-h-8 cursor-pointer text-muted-foreground">核对已留存的确切内容</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted/40 p-3 leading-5">{JSON.stringify(event.details ?? event, null, 2)}</pre></details>}
  </li>;
}

export function TaskEvidence({ workbench: w, taskId, exists }: { workbench: Workbench; taskId: string; exists: boolean }) {
  const [depth, setDepth] = useState<Depth>("overview");
  const [detail, setDetail] = useState<RemoteRecord | null>(null);
  const [events, setEvents] = useState<RemoteRecord[]>([]);
  const [eventCoverage, setEventCoverage] = useState<RemoteRecord>({});
  const [cursor, setCursor] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [loadedFor, setLoadedFor] = useState("");
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const loadedId = useRef("");
  const currentTaskId = useRef(taskId); currentTaskId.current = taskId;
  const invoke = useRef(w.invoke); invoke.current = w.invoke;
  const readable = exists && w.available("task.detail") && w.available("task.events");
  useEffect(() => {
    const key = `${taskId}:${retry}`;
    if (depth === "overview" || !readable || loadedId.current === key) return;
    loadedId.current = key; setLoaded(false); setLoadingMore(false); setError(""); setDetail(null); setEvents([]); setCursor(""); setEventCoverage({});
    void Promise.all([invoke.current("task.detail", { task_id: taskId }), invoke.current("task.events", { task_id: taskId, limit: 20 })]).then(([details, history]) => {
      if (currentTaskId.current !== taskId || loadedId.current !== key) return;
      if (details.result) setDetail(details.result);
      if (history.result) { setEvents(records(history.result.items)); setCursor(string(history.result.next_cursor)); setEventCoverage(record(history.result.coverage)); }
      if (!details.result || !history.result) setError(details.error?.message || history.error?.message || "暂时无法读取事项记录。");
      setLoadedFor(taskId); setLoaded(true);
    });
  }, [depth, readable, taskId, retry]);
  async function more() {
    if (!cursor || loadingMore) return;
    setLoadingMore(true); setError("");
    const response = await invoke.current("task.events", { task_id: taskId, limit: 20, cursor });
    if (currentTaskId.current !== taskId) return;
    if (response.result) {
      setEvents(previous => { const ids = new Set(previous.map(item => string(item.event_id))); return [...previous, ...records(response.result?.items).filter(item => !ids.has(string(item.event_id)))]; });
      setCursor(string(response.result.next_cursor));
    } else setError(response.error?.message || "暂时无法读取更多记录。");
    setLoadingMore(false);
  }
  const refs = records(detail?.conversation_refs), uniqueRefs = Array.from(new Map(refs.filter(item => string(item.conversation_id)).map(item => [string(item.conversation_id), item])).values());
  const coverage = { ...record(detail?.coverage), ...eventCoverage };
  return <section className="mt-4 border-t pt-3" aria-label="事项查看深度"><div role="tablist" aria-label="事项详情层级" className="flex flex-wrap gap-1">{tabs.map(tab => <Button key={tab.id} type="button" role="tab" aria-selected={depth === tab.id} aria-controls={`task-${taskId}-${tab.id}`} variant={depth === tab.id ? "secondary" : "ghost"} size="sm" className="min-h-9 rounded-lg" onClick={() => setDepth(tab.id)}>{tab.title}</Button>)}</div>
    {depth === "overview" ? <div id={`task-${taskId}-overview`} role="tabpanel" className="mt-2 text-xs leading-5 text-muted-foreground">上方显示当前状态和已知完成范围。查看进展或记录不会改变授权。</div> : <div id={`task-${taskId}-${depth}`} role="tabpanel" className="mt-3 space-y-3">
      {!readable ? <p className="text-xs leading-6 text-muted-foreground">当前 Agent 未开放事项详情与历史读取，或本方没有这项任务的记录。仍可查看上方已同步的概览。</p> : !loaded || loadedFor !== taskId ? <p role="status" className="text-xs text-muted-foreground">正在读取本方事项记录…</p> : <>
        {error && <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive"><span>{error}</span><Button type="button" size="sm" variant="outline" onClick={() => setRetry(value => value + 1)}>重试读取</Button></div>}
        <Coverage value={coverage} events={events} hasMore={!!cursor} />
        {!!uniqueRefs.length && <div className="rounded-xl bg-muted/30 p-3 text-xs"><p className="font-medium">涉及这件事的已保存对话</p><ul className="mt-2 flex flex-wrap gap-2">{uniqueRefs.map(ref => { const id = string(ref.conversation_id); return <li key={id}><Link className="inline-flex min-h-9 items-center rounded-lg border bg-background px-2.5 text-primary underline underline-offset-4" href={`/dashboard/chats?agent=${encodeURIComponent(w.agentId)}&conversation=${encodeURIComponent(id)}${ref.turn_id ? `&turn=${encodeURIComponent(string(ref.turn_id))}` : ""}`}>{ref.relation === "mention" ? "提及此事项" : "实际工作来源"} · {id}</Link></li>; })}</ul></div>}
        {!events.length && !error ? <p className="text-xs text-muted-foreground">本方尚未提供可回放的事件。</p> : <ol className="space-y-2">{events.map((event, index) => <EventRow key={string(event.event_id, String(index))} event={event} detailed={depth === "records"} agentId={w.agentId} />)}</ol>}
        {depth === "records" && detail && <details className="text-xs"><summary className="min-h-9 cursor-pointer text-muted-foreground">核对当前任务、授权问题与操作快照</summary><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-muted/40 p-3 leading-5">{JSON.stringify({ task: detail.task, operations: detail.operations, approvals: detail.approvals, collaboration: detail.collaboration, messages: detail.messages }, null, 2)}</pre></details>}
        {cursor && <Button type="button" size="sm" variant="outline" disabled={loadingMore} onClick={() => void more()}>{loadingMore ? "正在读取…" : "查看更多记录"}</Button>}
        <p className="text-xs text-muted-foreground">提及只指明上下文；具体审批需核对当前完整问题并明确决定。</p>
      </>}
    </div>}
  </section>;
}
