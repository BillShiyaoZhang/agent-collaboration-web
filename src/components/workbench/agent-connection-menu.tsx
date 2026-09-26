"use client";

import Link from "next/link";
import { useState } from "react";
import { MoreHorizontal, Pencil, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useWorkspace, workspaceRequest } from "@/components/workspace-provider";
import type { WorkspaceAgent } from "@/lib/workspace/workspace-types";

export function AgentConnectionMenu({ agent, workspace, onRenamed, onRemoved }: {
  agent: { id: string; name: string; urn: string }; workspace?: WorkspaceAgent;
  onRenamed?: (name: string) => void; onRemoved?: () => void;
}) {
  const { refresh } = useWorkspace();
  const [action, setAction] = useState<"rename" | "remove" | null>(null);
  const [name, setName] = useState(agent.name), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const unresolved = !!workspace?.submission || workspace?.conversations.some(item => item.pending) || workspace?.operations?.some(item => ["sending", "uncertain"].includes(item.phase));
  async function submit() {
    if (!action || busy || action === "remove" && unresolved) return;
    setBusy(true); setError("");
    try {
      if (action === "rename") {
        const result = await workspaceRequest<{ agent: { name: string } }>(`/api/agents/${encodeURIComponent(agent.id)}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
        onRenamed?.(result.agent.name);
      } else {
        await workspaceRequest(`/api/agents/${encodeURIComponent(agent.id)}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}" });
        onRemoved?.();
      }
      await refresh(); setAction(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "操作未完成，请恢复连接后重试。"); }
    finally { setBusy(false); }
  }
  return <>
    <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label={`管理 agent ${agent.name}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
      <DropdownMenuItem onSelect={() => { setName(agent.name); setError(""); setAction("rename"); }}><Pencil className="mr-2 h-4 w-4" />重命名</DropdownMenuItem>
      <DropdownMenuItem asChild><Link href={`/dashboard/connections?agent=${encodeURIComponent(agent.id)}`}><Settings2 className="mr-2 h-4 w-4" />连接设置</Link></DropdownMenuItem>
      <DropdownMenuSeparator /><DropdownMenuItem disabled={unresolved} className="text-destructive" onSelect={() => { setError(""); setAction("remove"); }}><Trash2 className="mr-2 h-4 w-4" />删除连接</DropdownMenuItem>
      {unresolved && <p className="max-w-56 px-2 py-1 text-xs leading-5 text-muted-foreground">有执行中的回合或结果未确认的操作，先核实后才能删除。</p>}
    </DropdownMenuContent></DropdownMenu>
    <Dialog open={!!action} onOpenChange={open => { if (!open && !busy) setAction(null); }}><DialogContent><DialogHeader><DialogTitle>{action === "rename" ? "重命名 agent" : "删除连接"}</DialogTitle><DialogDescription>{action === "rename" ? "名称用于这个账户的 agent 列表。" : "删除这个账户保存的连接，以及其 Web 聊天记录、联系人和合作副本。Agent 本机数据与配对保留，正在执行的任务不会因此停止。若以后重新连接，只能恢复 agent 仍可提供的记录。"}</DialogDescription></DialogHeader>
      {action === "rename" ? <Input aria-label="agent 名称" maxLength={80} value={name} onChange={event => setName(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && name.trim()) void submit(); }} /> : <p className="break-words text-sm font-medium">{agent.name}</p>}
      {error && <p role="alert" className="text-xs leading-5 text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={busy} onClick={() => setAction(null)}>取消</Button><Button variant={action === "remove" ? "destructive" : "default"} disabled={busy || action === "rename" && !name.trim()} onClick={() => void submit()}>{busy ? "正在保存…" : action === "remove" ? "确认删除连接" : "保存名称"}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
}
