"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/shared/utils";
import { useLocalTime } from "@/components/local-time";
import { ContactsSnapshot, InboxSnapshot, TasksSnapshot } from "@/components/workbench/snapshot-views";
import { CollaborationActions } from "@/components/workbench/collaboration-actions";
import { FriendRequests, SendPeerMessage, SentMessages } from "@/components/workbench/social-panels";
import { AddContactPanel } from "@/components/workbench/mutation-panels";
import { PairingPanel, RequestFeedback } from "@/components/workbench/pairing-panel";
import { Connection, useWorkbench } from "@/components/workbench/use-workbench";
import type { WorkspaceAgent } from "@/lib/workspace/workspace-types";
import { syncLabel } from "@/lib/workspace/workspace-client";
import { DeletedRecordsPanel } from "@/components/workbench/record-actions";

export type WorkbenchScope = "contacts" | "collaborations" | "connection";
export function RemoteWorkbench({ agent, initial, scope }: { agent: Connection; initial: WorkspaceAgent; scope: WorkbenchScope }) {
  return <ScopedWorkbench key={`${agent.id}:${scope}`} agent={agent} initial={initial} scope={scope} />;
}

function ScopedWorkbench({ agent, initial, scope }: { agent: Connection; initial: WorkspaceAgent; scope: WorkbenchScope }) {
  const w = useWorkbench(agent, initial), search = useSearchParams(), router = useRouter(), displayTime = useLocalTime();
  const [linkError, setLinkError] = useState("");
  const [discussionRequest, setDiscussionRequest] = useState<{ message: string; conversationId?: string } | null>(null);
  const [pendingDiscussion, setPendingDiscussion] = useState<{ message: string; conversationId: string } | null>(null);
  const [creating, setCreating] = useState(search.get("new") === "1");
  const subject = search.get("subject"), subjectAttempt = useRef("");
  const snapshotMethod = scope === "contacts" ? "contacts.list" : "collaboration.state";
  const snapshot = w.snapshots[snapshotMethod];
  const showConnection = scope === "connection" || !w.capabilitySnapshot || w.pairingOpen || !!w.errors.capabilities || w.sync.status === "needs_pairing";
  useEffect(() => { if (search.get("new") === "1") setCreating(true); }, [search]);
  useEffect(() => {
    if (!subject || !snapshot || subjectAttempt.current === subject) return;
    const target = document.getElementById(`subject-${subject}`);
    if (!target) return;
    subjectAttempt.current = subject;
    let disclosure = target instanceof HTMLDetailsElement ? target : target.closest("details");
    while (disclosure) { disclosure.open = true; disclosure = disclosure.parentElement?.closest("details") ?? null; }
    target.scrollIntoView({ block: "center" });
  }, [subject, snapshot]);

  async function continueDiscussion(message: string, sourceConversationId?: string) {
    if (w.selectingConversation || w.submission) return;
    setDiscussionRequest({ message, conversationId: sourceConversationId }); setLinkError("");
    const target = sourceConversationId || w.conversationId;
    if (target !== w.conversationId) {
      const known = w.conversations.some(value => value.id === target);
      const opened = known ? await w.selectConversation(target) : w.canReadConversation ? await w.readConversation(target) : false;
      if (!opened) { setLinkError("暂时无法打开这件事的原对话，尚未加入讨论草稿。恢复连接后可重试。"); return; }
    }
    setPendingDiscussion({ message, conversationId: target });
  }
  const { conversationId, selectingConversation, setText } = w;
  useEffect(() => {
    if (!pendingDiscussion || selectingConversation) return;
    if (conversationId !== pendingDiscussion.conversationId) { setPendingDiscussion(null); return; }
    // setText preserves the dirty draft synchronously in the shared account provider.
    // Switching pages only opens the original conversation; it never sends a message.
    setText(previous => previous.trim() ? `${previous}\n\n${pendingDiscussion.message}` : pendingDiscussion.message);
    setPendingDiscussion(null);
    const params = new URLSearchParams({ agent: agent.id });
    if (conversationId) params.set("conversation", conversationId);
    router.push(`/dashboard/chats?${params}`);
  }, [pendingDiscussion, conversationId, selectingConversation, setText, router, agent.id]);

  return <section className="min-w-0 space-y-3" aria-label={`${agent.name} 的${scope === "contacts" ? "联系人" : scope === "collaborations" ? "合作" : "连接设置"}`}>
    <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
      <p className="text-xs text-muted-foreground">{syncLabel(w.sync, !!w.capabilitySnapshot)}{snapshot ? ` · 最近同步 ${displayTime(snapshot.time / 1000)}` : ""}</p>
      <div className="flex flex-wrap gap-2">
        {scope === "collaborations" && <Button size="sm" variant="outline" onClick={() => setCreating(previous => !previous)} aria-expanded={creating}>{creating ? "收起草案" : "发起合作"}</Button>}
        {scope !== "connection" && <Button variant="ghost" size="sm" className="gap-1" disabled={!!w.busy[snapshotMethod] || !w.available(snapshotMethod)} onClick={() => void w.invoke(snapshotMethod)}><RefreshCw className={cn("h-3.5 w-3.5", w.busy[snapshotMethod] && "animate-spin")} />刷新</Button>}
        {scope !== "connection" && <Button id="connection-settings-toggle" variant="ghost" size="sm" className="gap-1" onClick={() => w.setPairingOpen(previous => !previous)} aria-expanded={showConnection} aria-controls="pairing-panel"><Settings2 className="h-3.5 w-3.5" />连接设置</Button>}
      </div>
    </div>
    {linkError && <div role="alert" className="rounded-md border p-3 text-sm"><p>{linkError}</p>{discussionRequest && <Button variant="outline" size="sm" className="mt-2" disabled={w.selectingConversation || !!w.busy["conversation.get"]} onClick={() => void continueDiscussion(discussionRequest.message, discussionRequest.conversationId)}>重试打开原对话</Button>}</div>}
    {w.cacheError && <p role="status" className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">{w.cacheError}</p>}
    <div id="pairing-panel" hidden={!showConnection}><PairingPanel agent={agent} workbench={w} featureCount={scope === "contacts" ? 1 : 2} /></div>
    {scope !== "connection" && <div className="min-w-0 rounded-md border bg-card py-3">
      {scope === "collaborations" && creating && <CollaborationActions workbench={w} initialOpen />}
      {scope === "contacts" && <><AddContactPanel workbench={w} /><FriendRequests workbench={w} /></>}
      {(w.busy[snapshotMethod] || w.errors[snapshotMethod]) && <div className="px-3 pb-3"><RequestFeedback busy={w.busy[snapshotMethod]} error={w.errors[snapshotMethod]} onRetry={() => void w.invoke(snapshotMethod)} /></div>}
      {!snapshot && <p role="status" className="px-3 py-4 text-sm text-muted-foreground">{["offline", "needs_pairing", "policy_paused", "policy_unavailable"].includes(w.sync.status) ? "这部分内容尚未同步，连接和授权恢复后会自动读取。" : "正在读取已获准的内容…"}</p>}
      {snapshot && (scope === "contacts" ? <ContactsSnapshot data={snapshot.data} workbench={w} syncedAt={snapshot.time} /> : <TasksSnapshot data={snapshot.data} workbench={w} onContinue={continueDiscussion} />)}
      <DeletedRecordsPanel agentId={agent.id} kind={scope === "contacts" ? "contact" : "collaboration"} recordStates={w.recordStates} snapshots={w.snapshots} onChanged={w.refreshSaved} />
      {scope === "collaborations" && !creating && <details className="mx-3 mt-3 border-t pt-3"><summary className="cursor-pointer text-xs text-muted-foreground">其他合作工具</summary><div className="mt-3"><CollaborationActions workbench={w} /></div></details>}
      {scope === "contacts" && <details className="mx-3 mt-3 border-t pt-3" open={search.get("inbox") === "1"}><summary className="cursor-pointer text-sm font-medium">联系人消息</summary><div className="mt-3"><SendPeerMessage workbench={w} /><SentMessages workbench={w} />{w.snapshots["inbox.list"] && <InboxSnapshot data={w.snapshots["inbox.list"].data} workbench={w} />}</div></details>}
    </div>}
  </section>;
}
