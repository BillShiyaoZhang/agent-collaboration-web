"use client";

import { useState } from "react";
import { Loader2, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { workspaceRequest } from "@/components/workspace-provider";
import { record, records, string, strings } from "@/lib/control/workbench-client";
import type { WorkspaceAgent, WorkspaceOperation, WorkspaceRecordState } from "@/lib/workspace/workspace-types";
import { useLocalTime } from "@/components/local-time";

type Kind = "contact" | "collaboration";
type Source = { snapshots: WorkspaceAgent["snapshots"]; operations?: WorkspaceOperation[]; submission?: unknown };
export function isRecordDeleted(states: WorkspaceRecordState[] | undefined, kind: Kind, id: string) {
  return !!states?.some(value => value.kind === kind && (value.id === id || value.relatedIds?.includes(id)) && value.deleted);
}
export function recordDeletionReason(source: Source, kind: Kind, id: string): string | undefined {
  if (source.submission || source.operations?.some(value => ["sending", "uncertain"].includes(value.phase) && !(value.call.method === "collaboration.execute" && value.call.params.action === "describe"))) return "先核实尚未确认的操作，再删除网页记录。";
  const data = record(source.snapshots["collaboration.state"]?.data);
  const view = Array.isArray(data.collaborations) ? data : record(data.collaboration ?? data.collaboration_v2);
  const approvals = records(data.pending_confirmations ?? data.approvals).filter(value => ["pending", "presenting", "expired"].includes(string(value.status)));
  const pending = (ids: Set<string>) => approvals.some(value => [value.subject_id, value.task_id, value.contact_id, record(value.target).id].some(target => typeof target === "string" && ids.has(target)));
  if (kind === "contact") {
    const contact = records(source.snapshots["contacts.list"]?.data.contacts ?? data.contacts).find(value => value.contact_id === id);
    const requests = records(source.snapshots["contacts.requests"]?.data.contact_requests ?? source.snapshots["contacts.requests"]?.data.requests ?? data.contact_requests);
    if (["pending", "requested"].includes(string(contact?.connection_status)) || requests.some(value => (value.contact_id === id || contact?.urn && [value.urn,value.peer_urn,value.sender_urn,value.recipient_urn].includes(contact.urn)) && ["pending", "requested", "sending"].includes(string(value.status)))) return "好友申请仍待处理，处理结束后可删除网页记录。";
    if (pending(new Set([id, string(contact?.urn)].filter(Boolean)))) return "先处理这个联系人的待确认请求。";
    return undefined;
  }
  const collaborations = records(view.collaborations);
  const collaboration = collaborations.find(value => value.collaboration_id === id || value.task_id === id);
  const taskId = string(collaboration?.task_id, id);
  const task = records(data.tasks).find(value => value.task_id === taskId);
  const linked = collaborations.filter(value => value.task_id === taskId || value.collaboration_id === id);
  const ids = new Set([id, taskId, ...linked.map(value => string(value.collaboration_id))].filter(Boolean));
  for (const operation of records(data.operations)) if (ids.has(string(operation.task_id)) || ids.has(string(operation.collaboration_id))) ids.add(string(operation.operation_id));
  if (pending(ids)) return "先处理这件合作的待确认请求。";
  if (linked.length) {
    if (linked.some(value => value.phase !== "closed" || value.withdraw_pending === true || !["cancelled", "withdrawn", "expired", "agreement_only_complete"].includes(string(value.closure_reason)) || value.closure_reason === "agreement_only_complete" && value.agreement_synced !== true)) return "合作仍在进行或结果待核实，结束后可删除网页记录。";
  } else if (!task || !["revoked", "completed", "cancelled", "expired", "denied", "rejected"].includes(string(task.status))) return "合作仍在进行或状态待核实，结束后可删除网页记录。";
  return undefined;
}

export function RecordActions({ agentId, kind, id, title, blockedReason, onChanged }: {
  agentId: string; kind: Kind; id: string; title: string; blockedReason?: string; onChanged?: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function remove() {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const data = await workspaceRequest<{ state: WorkspaceRecordState }>(`/api/agents/${encodeURIComponent(agentId)}/workspace/records`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id, deleted: true }) });
      setOpen(false);
      window.dispatchEvent(new CustomEvent("workspace-records-changed", { detail: { agentId, state: data.state } }));
      await onChanged?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "暂时无法删除网页记录。"); }
    finally { setBusy(false); }
  }
  return <Dialog open={open} onOpenChange={value => { if (!busy) { setOpen(value); setError(""); } }}>
    <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive" aria-label={`删除 ${title} 的网页记录`} title={blockedReason || "删除网页记录"} disabled={busy || !!blockedReason || !id} onClick={() => setOpen(true)}><Trash2 className="h-4 w-4" /></Button>
    <DialogContent hideCloseButton={busy}>
      <DialogHeader><DialogTitle>删除网页记录</DialogTitle><DialogDescription>将「{title}」从当前账户的{kind === "contact" ? "联系人" : "合作"}列表删除。Agent 本机的记录和已发生的操作会保留；你可以从“已删除记录”恢复显示。</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>取消</Button><Button variant="destructive" disabled={busy} onClick={() => void remove()}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}删除网页记录</Button></div>
    </DialogContent>
  </Dialog>;
}

function deletedTitle(value: WorkspaceRecordState, snapshots: WorkspaceAgent["snapshots"]) {
  if ("title" in value && typeof value.title === "string" && value.title) return value.title;
  const data = record(snapshots["collaboration.state"]?.data);
  if (value.kind === "contact") {
    const contact = records(snapshots["contacts.list"]?.data.contacts ?? data.contacts).find(item => item.contact_id === value.id);
    return strings(contact?.aliases)[0] || string(contact?.alias, "已删除联系人");
  }
  const view = Array.isArray(data.collaborations) ? data : record(data.collaboration ?? data.collaboration_v2);
  const collaboration = records(view.collaborations).find(item => item.collaboration_id === value.id || item.task_id === value.id);
  const task = records(data.tasks).find(item => item.task_id === value.id || item.task_id === collaboration?.task_id);
  return string(record(task?.scope).topic, string(record(collaboration?.terms).topic, "已删除合作"));
}
export function DeletedRecordsPanel({ agentId, kind, recordStates, snapshots, onChanged }: {
  agentId: string; kind: Kind; recordStates?: WorkspaceRecordState[]; snapshots: WorkspaceAgent["snapshots"]; onChanged?: () => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(""), [error, setError] = useState("");
  const displayTime = useLocalTime();
  const deleted = (recordStates || []).filter(value => value.kind === kind && value.deleted);
  async function restore(value: WorkspaceRecordState) {
    if (busy) return;
    setBusy(value.id); setError("");
    try {
      const data = await workspaceRequest<{ state: WorkspaceRecordState }>(`/api/agents/${encodeURIComponent(agentId)}/workspace/records`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id: value.id, deleted: false }) });
      window.dispatchEvent(new CustomEvent("workspace-records-changed", { detail: { agentId, state: data.state } }));
      await onChanged?.();
    } catch (failure) { setError(failure instanceof Error ? failure.message : "暂时无法恢复记录。"); }
    finally { setBusy(""); }
  }
  return <section aria-label={`已删除${kind === "contact" ? "联系人" : "合作"}记录`} className="border-t px-3 py-2">
    <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground" aria-expanded={open} onClick={() => setOpen(!open)}>已删除记录{deleted.length ? ` · ${deleted.length}` : ""}</Button>
    {open && <div className="mt-1 space-y-1">{error && <p role="alert" className="text-xs text-destructive">{error}</p>}{deleted.map(value => <div key={value.id} className="flex min-w-0 items-center gap-2 rounded-md bg-muted/30 px-2 py-1.5"><div className="min-w-0 flex-1"><p className="truncate text-sm">{deletedTitle(value, snapshots)}</p><p className="text-xs text-muted-foreground">删除于 {displayTime(value.updatedAt, { unit: "milliseconds" })}</p></div><Button size="sm" variant="outline" disabled={!!busy} aria-label={`恢复 ${deletedTitle(value, snapshots)}`} onClick={() => void restore(value)}>{busy === value.id ? <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="mr-1 h-3.5 w-3.5" />}恢复</Button></div>)}{!deleted.length && <p className="px-2 py-2 text-xs text-muted-foreground">没有已删除记录。</p>}</div>}
  </section>;
}
