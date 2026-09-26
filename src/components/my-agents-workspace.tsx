"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronLeft, List, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { workspaceRequest } from "@/components/workspace-provider";
import { ConversationPanel } from "@/components/workbench/conversation-panel";
import { ConversationLibrary } from "@/components/workbench/conversation-library";
import { AgentConnectionMenu } from "@/components/workbench/agent-connection-menu";
import { useWorkbench, type Connection } from "@/components/workbench/use-workbench";
import { syncLabel } from "@/lib/workspace/workspace-client";
import { cn } from "@/lib/shared/utils";
import type { AgentActivity } from "@/lib/product/activity-model";
import type { WorkspaceAgent } from "@/lib/workspace/workspace-types";

type MyAgentsProps = { initial: { agents: AgentActivity[] }; selectedAgentId?: string };
export function MyAgentsWorkspace({ initial, selectedAgentId }: MyAgentsProps) {
  const router = useRouter(), search = useSearchParams();
  const [agents, setAgents] = useState(initial.agents);
  // The server-rendered controls must wait for this entire static client tree.
  const [ready, setReady] = useState(false);
  useEffect(() => { setReady(true); }, []);
  const [query, setQuery] = useState(""), [listOpen, setListOpen] = useState(false), [error, setError] = useState("");
  // Server navigation payloads can be older than a confirmed local mutation.
  // Keep the initial payload as a seed and revalidate through account-scoped reads.
  const mutationVersion = useRef(0);
  const removedAgents = useRef(new Set<string>());
  const latestViews = useRef(new Map<string, WorkspaceAgent>());
  const rememberView = useCallback((id: string, view: WorkspaceAgent) => { latestViews.current.set(id, view); }, []);
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      const version = mutationVersion.current;
      try { const data = await workspaceRequest<{ agents: AgentActivity[] }>("/api/workspace/activity", { signal: controller.signal }); if (!controller.signal.aborted && version === mutationVersion.current) { setAgents(data.agents.filter(item => !removedAgents.current.has(item.workspace.agent.id))); setError(""); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "显示已保存内容。"); }
      if (!controller.signal.aborted) timer = setTimeout(refresh, document.hidden ? 30000 : 10000);
    };
    void refresh(); return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const requestedAgent = search.get("agent") || selectedAgentId;
  const selected = agents.find(item => item.workspace.agent.id === requestedAgent) || agents[0];
  function selectAgent(id: string) { setListOpen(false); router.push(`/dashboard/chats?agent=${encodeURIComponent(id)}`); }
  const needle = query.trim().toLocaleLowerCase();
  const visibleAgents = agents.filter(({ workspace }) => !needle || `${workspace.agent.name} ${workspace.agent.urn}`.toLocaleLowerCase().includes(needle));
  const sidebar = (current?: WorkspaceAgent, library?: React.ReactNode) => <>
    <div className="flex h-12 shrink-0 items-center justify-between border-b px-3"><h1 className="text-sm font-semibold">我的 agents</h1><div className="flex items-center"><Button asChild variant="ghost" size="icon" className="h-8 w-8" aria-label="添加 agent 连接"><Link href="/dashboard/agents"><Plus className="h-4 w-4" /></Link></Button><Button variant="ghost" size="icon" className="h-8 w-8 md:hidden" aria-label="收起 agent 列表" onClick={() => setListOpen(false)}><ChevronLeft className="h-4 w-4" /></Button></div></div>
    {agents.length > 3 && <div className="shrink-0 px-3 pt-2"><div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><Input aria-label="搜索我的 agents" placeholder="搜索 agent" value={query} onChange={event => setQuery(event.target.value)} className="h-8 pl-8 text-xs" /></div></div>}
    <div aria-label="我的 agent 列表" className="max-h-[38%] shrink-0 overflow-y-auto p-2">{visibleAgents.map(({ workspace, items }) => {
      const active = selected?.workspace.agent.id === workspace.agent.id;
      const row = active && current ? { ...workspace, conversations: current.conversations, submission: current.submission, operations: current.operations } : workspace;
      return <div key={workspace.agent.id} className={cn("mb-0.5 flex items-center rounded-lg", active ? "bg-primary/10" : "hover:bg-muted")}><button type="button" aria-label={`与 ${workspace.agent.name} 聊天`} aria-current={active ? "true" : undefined} onClick={() => selectAgent(workspace.agent.id)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-muted"><Bot className="h-4 w-4 text-primary" /></span><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{workspace.agent.name}</span><span className="mt-0.5 block truncate text-[11px] text-muted-foreground">{items.some(item => item.needsAction) ? "需要你处理" : syncLabel(workspace.sync, !!workspace.snapshots.capabilities)}</span></span></button><AgentConnectionMenu agent={workspace.agent} workspace={row} onRenamed={name => { mutationVersion.current++; setAgents(previous => previous.map(item => item.workspace.agent.id === workspace.agent.id ? { ...item, workspace: { ...item.workspace, agent: { ...item.workspace.agent, name } } } : item)); }} onRemoved={() => { mutationVersion.current++; removedAgents.current.add(workspace.agent.id); setAgents(previous => previous.filter(item => item.workspace.agent.id !== workspace.agent.id)); if (active) router.replace("/dashboard/chats"); }} /></div>;
    })}{!visibleAgents.length && <p className="px-2 py-3 text-xs text-muted-foreground">{query ? "没有匹配的 agent。" : "还没有连接自己的 agent。"}</p>}</div>
    {library && <div className="flex min-h-0 flex-1 flex-col border-t">{library}</div>}
  </>;
  return <fieldset disabled={!ready} inert={!ready} className="contents"><div data-my-agents-workspace className="relative flex h-full min-h-0 min-w-0 flex-1 overflow-hidden bg-card">
    {selected ? <AgentChatWorkspace key={selected.workspace.agent.id} agent={selected.workspace.agent} initial={{ ...(latestViews.current.get(selected.workspace.agent.id) || selected.workspace), agent: selected.workspace.agent }} rememberView={rememberView} sidebar={sidebar} listOpen={listOpen} onListOpen={() => setListOpen(true)} onListClose={() => setListOpen(false)} activityError={error} /> : <>
      <aside aria-label="agent 和聊天列表" className="hidden w-[264px] shrink-0 flex-col border-r bg-muted/15 md:flex">{sidebar()}</aside>
      <section className="flex min-h-0 min-w-0 flex-1 flex-col"><div className="flex flex-1 flex-col items-center justify-center px-6 text-center"><Bot className="h-8 w-8 text-primary" /><h2 className="mt-3 text-base font-medium">连接自己的 agent，开始聊天</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">完成接入授权后，agent 和聊天记录会直接出现在这里。</p><Button asChild size="sm" className="mt-4"><Link href="/dashboard/agents">添加连接</Link></Button></div><div className="shrink-0 border-t p-3"><Textarea aria-label="给 agent 的消息" disabled placeholder="连接自己的 agent 后即可发送消息" className="min-h-20 resize-none" /></div></section>
    </>}
  </div></fieldset>;
}

export function AgentChatWorkspace({ agent, initial, sidebar, listOpen, onListOpen, onListClose, activityError, rememberView }: {
  agent: Connection; initial: WorkspaceAgent; sidebar: (current: WorkspaceAgent, library: React.ReactNode) => React.ReactNode;
  listOpen: boolean; onListOpen: () => void; onListClose: () => void; activityError: string;
  rememberView: (id: string, view: WorkspaceAgent) => void;
}) {
  const w = useWorkbench(agent, initial), search = useSearchParams();
  // Returning to an agent uses this tab's current selection rather than an older
  // all-agent activity seed. The hook still reads authenticated server state and
  // its dirty-draft cache prevents a late read from replacing unsent edits.
  useEffect(() => {
    rememberView(agent.id, { ...initial, activeConversationId: w.conversationId,
      activeConversationState: { ...w.conversationState, draft: w.text },
      conversation: w.conversationId ? { ...w.currentSnapshot, conversation_id: w.conversationId, turns: w.turns } : null,
      conversations: w.conversations, snapshots: w.snapshots, sync: w.sync, identity: w.identity,
      hasEarlierTurns: w.hasEarlierTurns, submission: w.submission, operations: w.operations, recordStates: w.recordStates });
    // initial is a seed; the explicit hook fields above form the current view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id, rememberView, w.conversationId, w.conversationState, w.text, w.currentSnapshot, w.turns, w.conversations, w.snapshots, w.sync, w.identity, w.hasEarlierTurns, w.submission, w.operations, w.recordStates]);
  const linkedConversation = useRef("");
  const [linkError, setLinkError] = useState("");
  const requestedConversation = search.get("conversation");
  async function openLinkedConversation(id: string) {
    setLinkError("");
    const known = w.conversations.some(item => item.id === id);
    const opened = known ? await w.selectConversation(id) : w.canReadConversation ? await w.readConversation(id) : false;
    if (!opened) setLinkError("暂时无法打开原对话。恢复连接后可重试，当前草稿仍保留。");
  }
  useEffect(() => {
    if (!requestedConversation || requestedConversation === linkedConversation.current || w.selectingConversation || w.submission || (!w.canReadConversation && !w.conversations.some(item => item.id === requestedConversation))) return;
    linkedConversation.current = requestedConversation; void openLinkedConversation(requestedConversation);
    // A deep link gets one read attempt. Failed reads require an explicit retry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedConversation, w.selectingConversation, w.submission, w.canReadConversation, w.conversations]);
  const requestedTurn = search.get("turn");
  useEffect(() => { if (requestedTurn && w.turns.some(item => item.turn_id === requestedTurn)) document.getElementById(`turn-${requestedTurn}`)?.scrollIntoView({ block: "center" }); }, [requestedTurn, w.turns]);
  const current = { ...initial, conversations: w.conversations, submission: w.submission, operations: w.operations };
  return <>
    {listOpen && <button type="button" className="absolute inset-0 z-10 bg-black/20 md:hidden" aria-label="关闭聊天列表" onClick={onListClose} />}
    <aside aria-label="agent 和聊天列表" className={cn("min-h-0 w-[264px] max-w-[85vw] shrink-0 flex-col border-r bg-card md:relative md:flex md:max-w-none md:bg-muted/15", listOpen ? "absolute inset-y-0 left-0 z-20 flex shadow-lg" : "hidden")}>
      {sidebar(current, <ConversationLibrary workbench={w} sidebar onDeleted={w.afterConversationDeleted} />)}
    </aside>
    <section aria-label="聊天框" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center border-b px-2 md:hidden"><Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs" onClick={onListOpen}><List className="h-4 w-4" />agent 与聊天列表</Button></div>
      {(linkError || w.cacheError || activityError) && <div role={linkError ? "alert" : "status"} className="shrink-0 border-b bg-amber-50/60 px-4 py-2 text-xs leading-5 text-amber-900"><span>{linkError || w.cacheError || activityError}</span>{linkError && <Button size="sm" variant="outline" className="ml-2 h-7 text-xs" disabled={w.selectingConversation || !!w.busy["conversation.get"]} onClick={() => { if (requestedConversation) void openLinkedConversation(requestedConversation); }}>重试打开原对话</Button>}</div>}
      <ConversationPanel workbench={w} agentName={agent.name} desktop />
    </section>
  </>;
}
