"use client";

import { useEffect, useRef, useState } from "react";
import { Archive, Check, MessageCircle, MoreHorizontal, Pencil, RotateCcw, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { workspaceRequest } from "@/components/workspace-provider";
import { cn } from "@/lib/shared/utils";
import type { WorkspaceConversation, WorkspaceConversationMatch, WorkspaceConversationPage } from "@/lib/workspace/workspace-types";
import type { Workbench } from "./use-workbench";

type ConversationAction = { kind: "rename" | "delete"; item: WorkspaceConversation };
export function ConversationLibrary({ workbench: w, sidebar = false, onDeleted }: { workbench: Workbench; sidebar?: boolean; onDeleted?: (id: string) => void | Promise<void> }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"active" | "archived" | "deleted">("active");
  const [page, setPage] = useState<WorkspaceConversationPage | null>(null);
  const [error, setError] = useState("");
  const [action, setAction] = useState<ConversationAction | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState("");
  const [revision, setRevision] = useState(0);
  const changing = !!w.submission || w.selectingConversation || !!w.busy["conversation.send"];
  const url = `/api/agents/${encodeURIComponent(w.agentId)}/workspace/conversations`;
  const currentView = `${query}\0${filter}`;
  const view = useRef(currentView); view.current = currentView;
  const params = () => new URLSearchParams({ q: query, archived: filter === "archived" ? "archived" : filter === "deleted" ? "all" : "active", deleted: filter === "deleted" ? "deleted" : "active", limit: "30" });
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const search = new URLSearchParams({ q: query, archived: filter === "archived" ? "archived" : filter === "deleted" ? "all" : "active", deleted: filter === "deleted" ? "deleted" : "active", limit: "30" });
      void workspaceRequest<WorkspaceConversationPage>(`${url}?${search}`, { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setPage(result); setError(""); } }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, filter, url, w.conversations, revision]);
  const items: (WorkspaceConversation & { match?: WorkspaceConversationMatch })[] = page?.items || (filter === "active" && !query ? w.conversations.filter(item => !item.archived && !item.deleted) : []);
  async function update(item: WorkspaceConversation, patch: { title?: string; archived?: boolean; deleted?: boolean }) {
    if (busy) return;
    setBusy(item.id); setError("");
    try {
      await w.saveConversationState(patch, item.id);
      if (patch.deleted) await onDeleted?.(item.id);
      setRevision(previous => previous + 1); setAction(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "保存未成功，请恢复连接后重试。"); }
    finally { setBusy(""); }
  }
  return <section aria-label="已保存对话管理" className={cn("flex min-h-0 flex-col", sidebar ? "flex-1" : "border-b bg-muted/20 px-5 py-4")}>
    <div className={cn("space-y-2", sidebar && "px-3 py-2")}>
      <div className="relative"><Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" /><Input aria-label="搜索已保存对话" placeholder="搜索聊天记录" value={query} onChange={event => { setPage(null); setQuery(event.target.value); }} className="h-8 pl-8 text-xs" /></div>
      <div aria-label="聊天记录筛选" className="flex gap-1">{[["active", "对话"], ["archived", "归档"], ["deleted", "已删除"]].map(([key, label]) => <Button key={key} variant={filter === key ? "secondary" : "ghost"} size="sm" className="h-7 flex-1 px-1 text-xs" aria-pressed={filter === key} onClick={() => { setPage(null); setFilter(key as typeof filter); }}>{label}</Button>)}</div>
    </div>
    {error && <p role="alert" className="shrink-0 px-3 py-2 text-xs leading-5 text-destructive">{error}</p>}
    <div className={cn("min-h-0 overflow-y-auto", sidebar ? "flex-1 px-2 pb-2" : "mt-2 max-h-72")} aria-label="会话列表">
      {items.map(item => <div key={item.id} data-conversation-id={item.id} className={cn("group mb-0.5 flex items-center gap-1 rounded-lg", item.id === w.conversationId && filter !== "deleted" ? "bg-primary/10" : "hover:bg-muted")}>
        <button type="button" aria-label={`打开对话 ${item.title || "未命名对话"}`} aria-current={item.id === w.conversationId ? "true" : undefined} disabled={changing || !!busy || filter === "deleted"} onClick={() => void w.selectConversation(item.id)} className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-2 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"><MessageCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="min-w-0 flex-1"><span className="block truncate text-xs font-medium">{item.title || "未命名对话"}</span>{item.match && <span className="mt-0.5 block truncate text-xs text-muted-foreground">{item.match.excerpt}</span>}{(item.pending || item.unread) && <span className="mt-0.5 block text-[11px] text-muted-foreground">{item.pending ? "处理中" : "新回复"}</span>}</span>{item.unread && <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />}</button>
        <DropdownMenu><DropdownMenuTrigger asChild><Button variant="ghost" size="icon" className="mr-1 h-7 w-7 shrink-0" aria-label={`管理对话 ${item.title || "未命名对话"}`} disabled={!!busy}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger><DropdownMenuContent align="end">
          {filter === "deleted" ? <DropdownMenuItem onSelect={() => void update(item, { deleted: false })}><RotateCcw className="mr-2 h-4 w-4" />恢复对话</DropdownMenuItem> : <>
            <DropdownMenuItem onSelect={() => { setTitle(item.title || ""); setAction({ kind: "rename", item }); }}><Pencil className="mr-2 h-4 w-4" />重命名</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void update(item, { archived: !item.archived })}><Archive className="mr-2 h-4 w-4" />{item.archived ? "取消归档" : "归档对话"}</DropdownMenuItem>
            <DropdownMenuSeparator /><DropdownMenuItem className="text-destructive" disabled={changing || item.pending} onSelect={() => setAction({ kind: "delete", item })}><Trash2 className="mr-2 h-4 w-4" />删除对话</DropdownMenuItem>
          </>}
        </DropdownMenuContent></DropdownMenu>
      </div>)}
      {!items.length && page && <p className="px-2 py-4 text-xs leading-5 text-muted-foreground">{filter === "deleted" ? "没有已删除的对话。" : query ? "没有找到已保存记录。" : "暂无对话，直接在右侧开始聊天。"}</p>}
      {page?.hasMore && <Button variant="ghost" size="sm" className="h-8 w-full text-xs" onClick={() => { const search = params(), expectedView = currentView; search.set("before", page.before || ""); void workspaceRequest<WorkspaceConversationPage>(`${url}?${search}`).then(next => { if (view.current === expectedView) setPage({ ...next, items: [...page.items, ...next.items] }); }).catch(failure => { if (view.current === expectedView) setError(failure.message); }); }}>加载更多</Button>}
    </div>
    {query && <p className="shrink-0 px-3 py-2 text-[11px] leading-4 text-muted-foreground">仅搜索当前账户已同步保存的记录。</p>}
    <Dialog open={!!action} onOpenChange={open => { if (!open && !busy) setAction(null); }}><DialogContent><DialogHeader><DialogTitle>{action?.kind === "rename" ? "重命名对话" : "删除对话"}</DialogTitle><DialogDescription>{action?.kind === "rename" ? "新名称只用于这个账户的聊天列表。" : "删除后，此对话会从这个账户的 Web 聊天列表移至“已删除”，可以恢复。Agent 本机记录和配对保留；此操作不会停止正在执行的任务。"}</DialogDescription></DialogHeader>{action?.kind === "rename" && <Input aria-label="对话标题" maxLength={120} value={title} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && title.trim()) void update(action.item, { title: title.trim() }); }} />}{action?.kind === "delete" && <p className="text-sm">{action.item.title || "未命名对话"}</p>}{error && <p role="alert" className="text-xs text-destructive">{error}</p>}<DialogFooter><Button variant="outline" disabled={!!busy} onClick={() => setAction(null)}>取消</Button><Button variant={action?.kind === "delete" ? "destructive" : "default"} disabled={!!busy || action?.kind === "rename" && !title.trim()} onClick={() => { if (action) void update(action.item, action.kind === "rename" ? { title: title.trim() } : { deleted: true }); }}>{busy ? "正在保存…" : action?.kind === "delete" ? <><Trash2 className="mr-1 h-4 w-4" />确认删除</> : <><Check className="mr-1 h-4 w-4" />保存名称</>}</Button></DialogFooter></DialogContent></Dialog>
  </section>;
}
