"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Bot, ClipboardList, Inbox, MessageCircle, RefreshCw, Settings2, ShieldCheck, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/shared/utils";
import { displayTime, RpcMethod } from "@/lib/control/workbench-client";
import { ContactsSnapshot, InboxSnapshot, TasksSnapshot } from "@/components/workbench/snapshot-views";
import { CollaborationActions } from "@/components/workbench/collaboration-actions";
import { FriendRequests, SendPeerMessage, SentMessages } from "@/components/workbench/social-panels";
import { AddContactPanel } from "@/components/workbench/mutation-panels";
import { PairingPanel, RequestFeedback } from "@/components/workbench/pairing-panel";
import { ConversationPanel } from "@/components/workbench/conversation-panel";
import { Connection, useWorkbench } from "@/components/workbench/use-workbench";
import type { WorkspaceAgent } from "@/lib/workspace/workspace-types";
import { syncLabel } from "@/lib/workspace/workspace-client";
import { useWorkspace } from "@/components/workspace-provider";

type Tab = "conversation" | "contacts" | "tasks" | "inbox";
const tabItems = [
  { id: "conversation" as const, label: "对话", icon: MessageCircle, methods: ["conversation.send", "conversation.get"] },
  { id: "contacts" as const, label: "联系人", icon: Users, methods: ["contacts.list", "contacts.add", "contacts.requests", "contacts.respond"] },
  { id: "tasks" as const, label: "事项", icon: ClipboardList, methods: ["collaboration.state", "approval.respond", "collaboration.execute"] },
  { id: "inbox" as const, label: "收件箱", icon: Inbox, methods: ["inbox.list", "messages.send", "inbox.mark_read"] },
];
const readMethods: Record<Exclude<Tab, "conversation">, RpcMethod> = { contacts: "contacts.list", tasks: "collaboration.state", inbox: "inbox.list" };
const descriptions: Record<string, string> = { contacts: "熟悉的人，以及他们的 agent。", tasks: "协作的进展、授权范围和待确认请求。", inbox: "查看来自其他 agent 的消息与提议。" };

export function RemoteWorkbench({ agent, initial }: { agent: Connection; initial: WorkspaceAgent }) {
  return <AgentWorkbench key={agent.id} agent={agent} initial={initial} />;
}

function AgentWorkbench({ agent, initial }: { agent: Connection; initial: WorkspaceAgent }) {
  const w = useWorkbench(agent, initial);
  const { getDraft, saveDraft } = useWorkspace();
  const search = useSearchParams();
  const requestedTab = search.get("tab");
  const [activeTab, setActiveTab] = useState<Tab>(() => (["contacts", "tasks", "inbox"].includes(requestedTab || "") ? requestedTab as Tab : getDraft(agent.id)?.tab as Tab) || "conversation");
  useEffect(() => { if (requestedTab === "contacts" || requestedTab === "tasks" || requestedTab === "inbox") setActiveTab(requestedTab); }, [requestedTab]);
  useEffect(() => { saveDraft(agent.id, { tab: activeTab }); }, [agent.id, activeTab, saveDraft]);
  const tabs = tabItems.filter(tab => tab.methods.some(w.available) || (tab.id === "conversation" ? !!w.conversations.length || !!w.turns.length || !!w.submission : !!w.snapshots[readMethods[tab.id]]));
  const visibleTab = tabs.some(tab => tab.id === activeTab) ? activeTab : tabs[0]?.id;
  const snapshotMethod = visibleTab && visibleTab !== "conversation" ? readMethods[visibleTab] : null;
  const snapshot = snapshotMethod ? w.snapshots[snapshotMethod] : undefined;
  const subject = search.get("subject");
  const hasSubjectSnapshot = !!snapshot;
  useEffect(() => {
    if (!subject || !hasSubjectSnapshot) return;
    const target = document.getElementById(`subject-${subject}`);
    if (target instanceof HTMLDetailsElement) target.open = true;
    target?.scrollIntoView({ block: "center" });
  }, [subject, visibleTab, hasSubjectSnapshot]);

  return <div className="mx-auto max-w-6xl space-y-6 pb-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div className="flex min-w-0 items-center gap-3.5"><div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Bot className="h-7 w-7" strokeWidth={1.6} /></div><div className="min-w-0"><div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground"><span>远程工作台</span><span>·</span><span>{syncLabel(w.sync, !!w.capabilitySnapshot)}</span></div><h1 className="truncate text-2xl font-semibold tracking-tight sm:text-3xl">{agent.name}</h1></div></div><Button variant="outline" size="sm" className="gap-2 rounded-xl bg-card" onClick={() => w.setPairingOpen(previous => !previous)} aria-expanded={w.pairingOpen} aria-controls="pairing-panel"><Settings2 className="h-4 w-4" />连接设置</Button></header>
    {w.cacheError && <p role="status" className="rounded-xl border border-amber-200/70 bg-amber-50/50 px-4 py-3 text-xs leading-6 text-amber-900">{w.cacheError}</p>}
    <PairingPanel agent={agent} workbench={w} featureCount={tabs.length} />
    {!w.capabilitySnapshot && <div className="flex min-h-56 flex-col items-center justify-center rounded-2xl border border-dashed px-6 py-10 text-center"><span className="mb-4 rounded-2xl bg-muted p-3"><Sparkles className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} /></span><h2 className="font-medium">{w.sync.status === "needs_pairing" ? "完成一次配对，之后自动连接" : "正在连接你的 agent"}</h2><p className="mt-2 max-w-sm text-sm leading-6 text-muted-foreground">{w.sync.status === "needs_pairing" ? "请在 agent 所在设备确认配对。完成后，这里会自动同步。" : w.sync.error || "正在后台读取对话、联系人和协作事项。你可以继续浏览，内容会自动出现。"}</p></div>}
    {w.capabilitySnapshot && !tabs.length && <div className="rounded-2xl border bg-card p-8 text-center"><h2 className="font-medium">已验证身份，暂未开放工作台功能</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">请检查 agent 适配器与本机授权范围，再重新检查连接。</p></div>}
    {!!tabs.length && <section className="overflow-hidden rounded-2xl border bg-card shadow-sm">
      <div role="tablist" aria-label="工作台功能" className="flex overflow-x-auto border-b bg-muted/20 px-2 pt-2 sm:px-5">{tabs.map((tab, index) => <button type="button" role="tab" id={`tab-${tab.id}`} aria-controls={`panel-${tab.id}`} aria-selected={visibleTab === tab.id} tabIndex={visibleTab === tab.id ? 0 : -1} key={tab.id} onClick={() => setActiveTab(tab.id)} onKeyDown={event => { let next = index; if (event.key === "ArrowRight") next = (index + 1) % tabs.length; else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length; else if (event.key === "Home") next = 0; else if (event.key === "End") next = tabs.length - 1; else return; event.preventDefault(); setActiveTab(tabs[next].id); document.getElementById(`tab-${tabs[next].id}`)?.focus(); }} className={cn("relative flex min-h-12 min-w-0 flex-1 items-center justify-center gap-1 whitespace-nowrap rounded-t-xl px-2 text-xs sm:flex-none sm:gap-2 sm:px-4 sm:text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", visibleTab === tab.id ? "bg-card font-semibold text-primary after:absolute after:inset-x-4 after:bottom-0 after:h-0.5 after:rounded-full after:bg-primary" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}><tab.icon className="h-4 w-4" strokeWidth={1.8} />{tab.label}</button>)}</div>
      {visibleTab === "conversation" ? <ConversationPanel workbench={w} agentName={agent.name} /> : visibleTab && snapshotMethod ? <div role="tabpanel" id={`panel-${visibleTab}`} aria-labelledby={`tab-${visibleTab}`}><div className="flex items-start justify-between gap-3 p-5"><div><h2 className="font-medium">{tabs.find(tab => tab.id === visibleTab)?.label}</h2><p className="mt-1.5 text-xs leading-5 text-muted-foreground">{descriptions[visibleTab]}</p>{snapshot && <p className="mt-2 text-[11px] text-muted-foreground">已保存 · 最近同步 {displayTime(snapshot.time / 1000)}</p>}</div><Button variant="outline" size="sm" className="gap-1.5 rounded-xl" disabled={!!w.busy[snapshotMethod] || !w.available(snapshotMethod)} onClick={() => void w.invoke(snapshotMethod)}><RefreshCw className={cn("h-3.5 w-3.5", w.busy[snapshotMethod] && "animate-spin")} />刷新</Button></div>{visibleTab === "contacts" && <><AddContactPanel workbench={w} /><FriendRequests workbench={w} /></>}{visibleTab === "inbox" && <><SendPeerMessage workbench={w} /><SentMessages workbench={w} /></>}{visibleTab === "tasks" && <CollaborationActions workbench={w} />}{(w.busy[snapshotMethod] || w.errors[snapshotMethod]) && <div className="px-5 pb-4"><RequestFeedback busy={w.busy[snapshotMethod]} error={w.errors[snapshotMethod]} onRetry={() => void w.invoke(snapshotMethod)} /></div>}{!snapshot && !w.errors[snapshotMethod] && !["offline", "needs_pairing"].includes(w.sync.status) && <div aria-hidden className="space-y-3 px-5 pb-6">{[1, 2, 3].map(key => <div key={key} className="h-24 animate-pulse rounded-2xl bg-muted/60" />)}</div>}{!snapshot && ["offline", "needs_pairing"].includes(w.sync.status) && <p role="status" className="px-5 pb-8 text-sm leading-6 text-muted-foreground">这部分内容尚未同步。连接恢复后会自动读取。</p>}{snapshot && (visibleTab === "contacts" ? <ContactsSnapshot data={snapshot.data} workbench={w} syncedAt={snapshot.time} /> : visibleTab === "tasks" ? <TasksSnapshot data={snapshot.data} workbench={w} /> : <InboxSnapshot data={snapshot.data} workbench={w} />)}</div> : null}
    </section>}
    <p className="flex items-start justify-center gap-1.5 px-2 text-center text-[11px] leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />数据以本机 agent 为准；网页保存同步副本，所有操作都由本机 agent 执行。</p>
  </div>;
}


