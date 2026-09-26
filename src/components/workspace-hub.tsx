"use client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Bot, CheckCircle2, ChevronRight, ClipboardList, MessageCircle, Search, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useLocalTime } from "@/components/local-time";
import { workspaceRequest } from "@/components/workspace-provider";
import { record, records, string } from "@/lib/control/workbench-client";
import { syncLabel } from "@/lib/workspace/workspace-client";
import type { AgentActivity } from "@/lib/product/activity-model";

export function WorkspaceHub({ initial, mode }: { initial: { agents: AgentActivity[] }; mode: "chats" | "collaborations" | "contacts" }) {
  const search=useSearchParams();
  const [chooseAgent,setChooseAgent]=useState(false);
  const [agents, setAgents] = useState(initial.agents), [query, setQuery] = useState(""), [filter, setFilter] = useState(search.get("filter")==="decision"?"decision":"all"), [error, setError] = useState("");
  const displayTime = useLocalTime();
  useEffect(() => {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try { const data = await workspaceRequest<{ agents: AgentActivity[] }>("/api/workspace/activity", { signal: controller.signal }); if (!controller.signal.aborted) { setAgents(data.agents); setError(""); } }
      catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "显示已保存内容。"); }
      if (!controller.signal.aborted) timer = setTimeout(refresh, document.hidden ? 30000 : 10000);
    };
    timer = setTimeout(refresh, 10000); return () => { controller.abort(); clearTimeout(timer); };
  }, []);
  const title = { chats: "聊天", collaborations: "合作", contacts: "联系人" }[mode];
  const Icon = mode === "chats" ? MessageCircle : mode === "collaborations" ? ClipboardList : Users;
  const needle = query.trim().toLocaleLowerCase();
  const allItems = agents.flatMap(agent => agent.items), pending = allItems.filter(item => item.needsAction).length;
  const matches = (value: string) => !needle || value.toLocaleLowerCase().includes(needle);
  return <div className="space-y-6">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><h1 className="flex items-center gap-3 text-2xl font-semibold"><Icon className="h-6 w-6" />{title}</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">{mode === "chats" ? "从自己的 agent 和最近主题继续。回复、决定与结果会自动更新。" : mode === "collaborations" ? "看清目标、进展和下一步由谁承担。" : "你自己的 agent 保存的联系人与通信关系。"}</p></div>{mode==="collaborations" ? <Button variant="outline" onClick={()=>setChooseAgent(!chooseAgent)}>发起合作</Button> : <Button asChild variant="outline"><Link href="/dashboard/agents">管理连接</Link></Button>}</header>
    {chooseAgent && <section aria-label="选择自己的 agent" className="rounded-xl border bg-card p-4"><h2 className="text-sm font-medium">由哪个自己的 agent 负责？</h2><div className="mt-3 flex flex-wrap gap-2">{agents.map(({workspace})=><Button key={workspace.agent.id} asChild variant="outline"><Link href={`/dashboard/agents/${workspace.agent.id}?tab=tasks&new=1`}>{workspace.agent.name}</Link></Button>)}</div></section>}
    {error && <p role="status" className="rounded-xl border p-3 text-sm text-amber-800">{error}</p>}
    {!!pending && <Link href="/dashboard/collaborations?filter=decision" className="flex items-center justify-between rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><span>{pending} 项需要你决定或核实</span><ChevronRight className="h-4 w-4" /></Link>}
    {!agents.length ? <section className="rounded-2xl border border-dashed p-8 text-center"><Bot className="mx-auto h-8 w-8 text-primary" /><h2 className="mt-4 font-medium">连接自己的 agent，从一句话开始</h2><p className="mx-auto mt-2 max-w-lg text-sm leading-7 text-muted-foreground">请已能正常运行的 Hermes 安装并配置官网接入组件，在一次性网页链接中核对授权。</p><Button asChild className="mt-5"><Link href="/dashboard/agents">查看连接指南</Link></Button></section> : <>
      <div className="relative"><Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" /><Input aria-label={`搜索${title}`} value={query} onChange={event => setQuery(event.target.value)} placeholder={`搜索${mode === "chats" ? "agent 或已保存主题" : mode === "contacts" ? "姓名、别名或 URN" : "目标或进展"}…`} className="pl-9" /></div>
      {mode === "chats" && <div className="space-y-4">{agents.filter(({ workspace }) => matches(`${workspace.agent.name} ${workspace.agent.urn} ${workspace.conversations.map(value => value.title).join(" ")}`)).map(({ workspace, items }) => {
        const current = workspace.conversations.find(value => value.id === workspace.activeConversationId) || workspace.conversations.find(value=>!value.archived);
        const latest = records(workspace.conversation?.turns).at(-1), summary = string(latest?.response || latest?.text, "从一句话开始");
        return <article key={workspace.agent.id} className="rounded-2xl border bg-card p-5"><Link href={`/dashboard/agents/${workspace.agent.id}?tab=conversation`} className="flex min-w-0 items-start gap-4 rounded-lg focus-visible:ring-2"><span className="rounded-xl bg-primary/10 p-3"><Bot className="h-6 w-6 text-primary" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="text-lg font-medium">{workspace.agent.name}</h2>{items.some(value => value.needsAction) && <span className="rounded-full bg-amber-100 px-2 text-xs text-amber-900">需我处理</span>}{current?.pending && <span className="text-xs text-muted-foreground">处理中</span>}</div><p className="mt-1 text-sm font-medium">{current?.title || "最近对话"}</p><p className="mt-2 line-clamp-2 break-words text-sm leading-6 text-muted-foreground">{summary}</p><p className="mt-3 text-xs text-muted-foreground">{syncLabel(workspace.sync, !!workspace.sync.lastSuccessAt)}{workspace.sync.lastSuccessAt ? ` · 最近核验 ${displayTime(workspace.sync.lastSuccessAt / 1000)}` : ""}</p></div><ChevronRight className="mt-2 h-4 w-4 shrink-0" /></Link>{workspace.conversations.length > 1 && <details className="mt-4 border-t pt-3"><summary className="cursor-pointer text-sm text-muted-foreground">其它已保存主题 · {workspace.conversations.length}</summary><div className="mt-2 space-y-2">{workspace.conversations.filter(value => !value.archived).slice(0, 8).map(value => <Link className="block rounded-lg p-2 text-sm hover:bg-muted" key={value.id} href={`/dashboard/agents/${workspace.agent.id}?tab=conversation&conversation=${encodeURIComponent(value.id)}`}>{value.title || "未命名主题"}{value.unread ? " · 新回复" : ""}</Link>)}</div></details>}</article>;
      })}</div>}
      {mode === "collaborations" && <><div className="flex flex-wrap gap-2" aria-label="协作筛选">{[["all", "全部"], ["decision", "需我处理"], ["working", "进行中"], ["result", "已有结果"]].map(([key, label]) => <Button key={key} size="sm" variant={filter === key ? "default" : "outline"} onClick={() => setFilter(key)} aria-pressed={filter === key}>{label}</Button>)}</div><div className="space-y-3">{allItems.filter(item => matches(`${item.title} ${item.summary} ${item.agentName}`) && (filter==="all" ? true : filter==="decision" ? item.needsAction : filter==="working" ? ["working","waiting"].includes(item.category) : item.category==="result")).map(item => <Link key={`${item.agentId}:${item.id}`} href={item.href} className="block rounded-2xl border bg-card p-5 hover:border-primary/40"><div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-medium">{item.title}</h2><span className="text-xs text-muted-foreground">{item.agentName}</span></div><p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm leading-7">{item.summary}</p><p className="mt-3 text-xs text-muted-foreground">{item.needsAction ? "需要你决定或核实" : "按最后核验的状态，当前无需你操作"} · 最近核验 {displayTime(item.sourceAt / 1000)}</p></Link>)}{!allItems.length && <p className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">尚未同步协作事项。可以在自己的 agent 对话中表达目标，或从“发起合作”开始。</p>}</div></>}
      {mode === "contacts" && <div className="space-y-3">{agents.flatMap(({ workspace }) => records(workspace.snapshots["contacts.list"]?.data.contacts).filter(contact => matches(`${string(contact.name)} ${JSON.stringify(contact.aliases)} ${string(contact.urn)}`)).map(contact => <Link key={`${workspace.agent.id}:${string(contact.contact_id)}`} href={`/dashboard/agents/${workspace.agent.id}?tab=contacts&subject=${encodeURIComponent(string(contact.contact_id))}`} className="block rounded-xl border bg-card p-4"><div className="flex items-center gap-2"><Users className="h-4 w-4" /><h2 className="font-medium">{string(contact.name, Array.isArray(contact.aliases) ? string(contact.aliases[0], "联系人") : "联系人")}</h2>{contact.status === "connected" && <CheckCircle2 className="h-4 w-4 text-primary" />}</div><p className="mt-2 break-all text-xs text-muted-foreground">{string(contact.urn)}</p><p className="mt-2 text-xs text-muted-foreground">{workspace.agent.name} 的通讯录 · 连接不等于现实身份核实或协作授权</p></Link>))}</div>}
    </>}
  </div>;
}
