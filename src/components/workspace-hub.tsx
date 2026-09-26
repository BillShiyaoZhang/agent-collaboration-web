"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useLocalTime } from "@/components/local-time";
import { workspaceRequest } from "@/components/workspace-provider";
import { RemoteWorkbench } from "@/components/remote-workbench";
import type { AgentActivity, ActivityItem } from "@/lib/product/activity-model";
import { record, records, string } from "@/lib/control/workbench-client";
import { DeletedRecordsPanel, RecordActions, isRecordDeleted, recordDeletionReason } from "@/components/workbench/record-actions";
import type { WorkspaceAgent } from "@/lib/workspace/workspace-types";

function businessRecordId(item: ActivityItem, workspace: WorkspaceAgent) {
  const data = record(workspace.snapshots["collaboration.state"]?.data), view = Array.isArray(data.collaborations) ? data : record(data.collaboration ?? data.collaboration_v2);
  const collaboration = records(view.collaborations).find(value => value.collaboration_id === item.id || value.task_id === item.id);
  if (collaboration) return string(collaboration.collaboration_id, string(collaboration.task_id));
  return records(data.tasks).some(value => value.task_id === item.id) ? item.id : "";
}

export function WorkspaceHub({ initial, mode }: { initial: { agents: AgentActivity[] }; mode: "collaborations" | "contacts" }) {
  const search = useSearchParams(), router = useRouter(), displayTime = useLocalTime();
  const [agents, setAgents] = useState(initial.agents), [query, setQuery] = useState(""), [filter, setFilter] = useState(search.get("filter") === "decision" ? "decision" : "all"), [error, setError] = useState("");
  const [chooseAgent, setChooseAgent] = useState(false);
  const readVersion = useRef(0);
  const requestedAgent = search.get("agent");
  const selected = agents.find(value => value.workspace.agent.id === requestedAgent) || (mode === "contacts" ? agents[0] : undefined);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const version = ++readVersion.current;
    try { const data = await workspaceRequest<{ agents: AgentActivity[] }>("/api/workspace/activity", { signal }); if (!signal?.aborted && version === readVersion.current) { setAgents(data.agents); setError(""); } }
    catch (failure) { if (!signal?.aborted && version === readVersion.current) setError(failure instanceof Error ? failure.message : "显示已保存内容。"); }
  }, []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll, document.hidden ? 30000 : 10000); };
    timer = setTimeout(poll, 10000); return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  useEffect(() => { if (search.get("filter") === "decision") setFilter("decision"); }, [search]);
  const title = mode === "contacts" ? "联系人" : "合作", needle = query.trim().toLocaleLowerCase();
  const allItems = agents.flatMap(({workspace,items}) => items.filter(item => { const id = businessRecordId(item, workspace); return !id || !isRecordDeleted(workspace.recordStates, "collaboration", id); }));
  const visible = allItems.filter(item => (!needle || `${item.title} ${item.summary} ${item.agentName}`.toLocaleLowerCase().includes(needle)) && (filter === "all" || (filter === "decision" ? item.needsAction : filter === "working" ? ["working", "waiting"].includes(item.category) : item.category === "result")));
  function choose(id: string, creating = false) { const params = new URLSearchParams({ agent: id }); if (creating) params.set("new", "1"); router.push(`/dashboard/${mode}?${params}`); setChooseAgent(false); }
  return <div className="min-w-0 space-y-3">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-3"><h1 className="text-lg font-semibold">{title}</h1>{!!agents.length && <label className="flex items-center gap-2 text-xs text-muted-foreground"><span>自己的 agent</span><select aria-label={`${title}所属 agent`} className="h-8 max-w-52 rounded-md border bg-card px-2 text-sm text-foreground" value={selected?.workspace.agent.id || ""} onChange={event => event.target.value ? choose(event.target.value) : router.push(`/dashboard/${mode}`)}>{mode === "collaborations" && <option value="">全部 agents</option>}{agents.map(({ workspace }) => <option key={workspace.agent.id} value={workspace.agent.id}>{workspace.agent.name}</option>)}</select></label>}</div>
      {mode === "collaborations" && !selected && <Button size="sm" onClick={() => agents.length === 1 ? choose(agents[0].workspace.agent.id, true) : setChooseAgent(value => !value)} disabled={!agents.length}>发起合作</Button>}
    </header>
    {error && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">{error}</p>}
    {!agents.length ? <section className="rounded-md border border-dashed p-5"><h2 className="text-sm font-medium">尚未连接自己的 agent</h2><p className="mt-1 text-sm text-muted-foreground">连接 agent 后可查看其{title}。</p><Button asChild size="sm" variant="outline" className="mt-3"><Link href="/dashboard/agents">添加连接</Link></Button></section> : <>
      {chooseAgent && <section aria-label="选择自己的 agent" className="flex flex-wrap items-center gap-2 rounded-md border p-3"><span className="text-xs text-muted-foreground">由哪个 agent 负责？</span>{agents.map(({ workspace }) => <Button key={workspace.agent.id} size="sm" variant="outline" onClick={() => choose(workspace.agent.id, true)}>{workspace.agent.name}</Button>)}</section>}
      {selected ? <RemoteWorkbench agent={selected.workspace.agent} initial={selected.workspace} scope={mode} /> : <>
        <div className="flex flex-wrap items-center gap-2"><div className="relative w-full md:max-w-sm"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input aria-label="搜索合作" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索目标、进展或 agent" className="h-9 pl-8" /></div><div className="flex flex-wrap gap-1" aria-label="协作筛选">{[["all", "全部"], ["decision", "需我处理"], ["working", "进行中"], ["result", "已有结果"]].map(([key, label]) => <Button key={key} size="sm" className="h-8 px-2" variant={filter === key ? "secondary" : "ghost"} onClick={() => setFilter(key)} aria-pressed={filter === key}>{label}</Button>)}</div></div>
        <div className="divide-y rounded-md border bg-card">{visible.map(item => {
          const source = new URL(item.href, "https://workspace.invalid"), params = new URLSearchParams({ agent: item.agentId });
          if (source.searchParams.get("subject")) params.set("subject", source.searchParams.get("subject")!);
          const workspace = agents.find(value => value.workspace.agent.id === item.agentId)?.workspace;
          const businessId = workspace ? businessRecordId(item, workspace) : "";
          return <article key={`${item.agentId}:${item.id}`} className="flex min-w-0 items-start gap-2 p-3"><Link href={`/dashboard/collaborations?${params}`} className="min-w-0 flex-1 rounded-sm outline-none focus-visible:ring-2"><div className="flex flex-wrap items-center gap-2"><h2 className="text-sm font-medium">{item.title}</h2><span className="text-xs text-muted-foreground">{item.agentName}</span>{item.needsAction && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-900">需我处理</span>}</div><p className="mt-1 line-clamp-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">{item.summary}</p><time className="mt-1 block text-xs text-muted-foreground">最近核验 {displayTime(item.sourceAt / 1000)}</time></Link>{workspace && businessId && <RecordActions agentId={item.agentId} kind="collaboration" id={businessId} title={item.title} blockedReason={recordDeletionReason(workspace, "collaboration", businessId)} onChanged={() => refresh()} />}<ChevronRight className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" /></article>;
        })}{!visible.length && <p className="p-5 text-sm text-muted-foreground">{allItems.length ? "没有匹配的合作。" : "尚未同步合作事项，可从“发起合作”开始。"}</p>}</div>
        {agents.filter(({workspace}) => workspace.recordStates?.some(value => value.kind === "collaboration" && value.deleted)).map(({workspace}) => <section key={workspace.agent.id} className="rounded-md border bg-card"><h2 className="px-3 pt-2 text-xs font-medium">{workspace.agent.name}</h2><DeletedRecordsPanel agentId={workspace.agent.id} kind="collaboration" recordStates={workspace.recordStates} snapshots={workspace.snapshots} onChanged={() => refresh()} /></section>)}
      </>}
    </>}
  </div>;
}
