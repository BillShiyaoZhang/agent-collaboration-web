"use client";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { workspaceRequest } from "@/components/workspace-provider";
import type { WorkspaceConversationPage } from "@/lib/workspace/workspace-types";
import type { Workbench } from "./use-workbench";
export function ConversationLibrary({ workbench:w }: {workbench:Workbench}) {
  const [query,setQuery]=useState(""),[archived,setArchived]=useState(false),[page,setPage]=useState<WorkspaceConversationPage|null>(null),[error,setError]=useState(""),[title,setTitle]=useState("");
  useEffect(()=>setTitle(w.conversations.find(v=>v.id===w.conversationId)?.title||""),[w.conversationId,w.conversations]);
  const url=`/api/agents/${encodeURIComponent(w.agentId)}/workspace/conversations`;
  useEffect(()=>{const controller=new AbortController();const timer=setTimeout(()=>{const params=new URLSearchParams({q:query,archived:archived?"archived":"active",limit:"30"});void workspaceRequest<WorkspaceConversationPage>(`${url}?${params}`,{signal:controller.signal}).then(setPage).catch(e=>{if(!controller.signal.aborted)setError(e.message);});},250);return()=>{clearTimeout(timer);controller.abort();};},[query,archived,url,w.conversations]);
  const current=w.conversations.find(v=>v.id===w.conversationId);
  async function update(value:{title?:string;archived?:boolean}) { try { await w.saveConversationState(value); setError(""); } catch(e) {setError(e instanceof Error?e.message:"保存未成功。");} }
  return <section aria-label="已保存对话管理" className="space-y-3 border-b bg-muted/20 px-5 py-4">
    <div className="flex flex-wrap gap-2"><Input aria-label="搜索已保存对话" placeholder="搜索已保存的标题、消息、回复" value={query} onChange={e=>setQuery(e.target.value)} className="min-w-0 flex-1" /><Button variant="outline" aria-pressed={archived} onClick={()=>setArchived(!archived)}>{archived?"查看未归档":"查看归档"}</Button></div>
    <p className="text-xs leading-5 text-muted-foreground">搜索范围：当前账号已同步并保存的记录。宿主更早且尚未同步的记录不在搜索结果内。</p>
    {error&&<p role="alert" className="text-xs text-destructive">{error}</p>}
    {page&&<div className="max-h-52 space-y-1 overflow-y-auto">{page.items.map(item=><button key={item.id} type="button" onClick={()=>void w.selectConversation(item.id)} className="block w-full rounded-lg p-2 text-left hover:bg-muted focus-visible:ring-2"><span className="text-sm">{item.title||"未命名主题"}{item.unread?" · 新回复":""}{item.archived?" · 已归档":""}</span>{item.match&&<span className="mt-1 block truncate text-xs text-muted-foreground">{item.match.excerpt}</span>}</button>)}{!page.items.length&&<p className="py-3 text-sm text-muted-foreground">没有找到已保存记录。</p>}{page.hasMore&&<Button variant="ghost" onClick={()=>{const params=new URLSearchParams({q:query,archived:archived?"archived":"active",before:page.before||"",limit:"30"});void workspaceRequest<WorkspaceConversationPage>(`${url}?${params}`).then(next=>setPage({...next,items:[...page.items,...next.items]})).catch(e=>setError(e.message));}}>加载更多主题</Button>}</div>}
    {w.conversationId&&<div className="flex flex-wrap gap-2 border-t pt-3"><Input aria-label="对话标题" maxLength={120} value={title} onChange={e=>setTitle(e.target.value)} className="min-w-0 flex-1" /><Button variant="outline" disabled={!title.trim()} onClick={()=>void update({title:title.trim()})}>保存标题</Button><Button variant="outline" onClick={()=>void update({archived:!current?.archived})}>{current?.archived?"取消归档":"归档主题"}</Button></div>}
  </section>;
}
