"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Bot, Check, ChevronRight, CircleAlert, Fingerprint, Loader2, Plus, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

import { useWorkspace } from "@/components/workspace-provider";
import { syncLabel } from "@/lib/workspace/workspace-client";
import { useLocalTime } from "@/components/local-time";
import { AgentConnectionMenu } from "@/components/workbench/agent-connection-menu";

function responseError(data: unknown, fallback: string, status: number) {
  if (status === 401) return "登录已过期，请重新登录后再试。";
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string") return data.error;
  return fallback;
}

function requestError(error: unknown, fallback: string) {
  if (error instanceof TypeError) return "网络连接中断，请检查网络后重试。";
  return error instanceof Error ? error.message : fallback;
}

const avatarColors = ["bg-emerald-50 text-emerald-700", "bg-amber-50 text-amber-700", "bg-sky-50 text-sky-700"];

function avatarColor(id: string) {
  return avatarColors[Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % avatarColors.length];
}

function ConnectionSkeleton() {
  return (
    <div className="space-y-2" role="status" aria-label="正在加载连接">
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-md border bg-card p-3 motion-safe:animate-pulse" aria-hidden="true">
          <div className="h-5 w-2/3 rounded-md bg-muted" />
          <div className="mt-3 h-3 w-full rounded-md bg-muted" />
        </div>
      ))}
      <span className="sr-only">正在加载你的连接…</span>
    </div>
  );
}

export default function AgentsPage() {
  const displayTime = useLocalTime();
  const router = useRouter();
  const { connections: agents, loading, error: loadError, refresh: load, requestSync, getCachedAgent } = useWorkspace();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [urn, setUrn] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState("");
  const mounted = useRef(false);
  const submitting = useRef(false);
  const connectRequest = useRef<AbortController | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const dialogOpener = useRef<HTMLElement | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; connectRequest.current?.abort(); };
  }, []);
  function changeOpen(nextOpen: boolean) {
    if (submitting.current) return;
    if (nextOpen) {
      dialogOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setFormError("");
    }
    setOpen(nextOpen);
  }

  async function connect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    if (!name.trim() || !urn.trim()) {
      setFormError("请填写连接名称与 agent 的完整 URN。");
      return;
    }
    submitting.current = true;
    setBusy(true);
    setFormError("");
    const controller = new AbortController();
    connectRequest.current = controller;
    try {
      const response = await fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), urn: urn.trim() }),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(responseError(data, "无法保存连接，请稍后重试。", response.status));
      if (!data?.id) throw new Error("无法读取连接信息，请刷新连接列表。");
      if (!mounted.current || controller.signal.aborted) return;
      void load();
      void requestSync(data.id);
      setQuery("");
      setSuccess(`已保存「${data.name}」，正在进入工作台…`);
      setName("");
      setUrn("");
      setOpen(false);
      router.push(`/dashboard/connections?agent=${encodeURIComponent(data.id)}`);
    } catch (error) {
      if (mounted.current && !controller.signal.aborted) setFormError(requestError(error, "无法保存连接，请稍后重试。"));
    } finally {
      submitting.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  const search = query.trim().toLocaleLowerCase();
  const filteredAgents = agents.filter((agent) => `${agent.name} ${agent.urn}`.toLocaleLowerCase().includes(search));

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <div className="space-y-3">
        <header className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><h1 className="text-lg font-semibold">我的连接</h1>{!loading && <span className="text-xs text-muted-foreground">{agents.length} 个</span>}</div><DialogTrigger asChild><Button ref={addButton} size="sm" className="gap-1"><Plus className="h-4 w-4" />添加连接</Button></DialogTrigger></header>
        {success && <p role="status" className="flex items-center gap-2 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-primary"><Check className="h-4 w-4" />{success}</p>}
        {loadError && <div role="alert" className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/20 p-3"><p className="min-w-0 flex-1 text-sm">{loadError}</p><Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="mr-1 h-3.5 w-3.5" />重试</Button></div>}
        {loading && !agents.length && <ConnectionSkeleton />}
        {!!agents.length && <section aria-label="已保存的连接" className="space-y-3">
          <div className="relative w-full md:max-w-sm"><Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" /><Input ref={searchInput} type="search" aria-label="搜索连接名称或 URN" placeholder="搜索名称或 URN…" value={query} onChange={event => setQuery(event.target.value)} className="h-9 pl-8 pr-9" />{query && <Button size="icon" variant="ghost" aria-label="清空搜索" className="absolute right-0.5 top-0.5 h-8 w-8" onClick={() => { setQuery(""); searchInput.current?.focus(); }}><X className="h-3.5 w-3.5" /></Button>}</div>
          <div className="divide-y rounded-md border bg-card">{filteredAgents.map(agent => <article key={agent.id} className="flex min-w-0 items-center gap-3 p-3"><div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg ${avatarColor(agent.id)}`}><Bot className="h-5 w-5" /></div><Link href={`/dashboard/chats?agent=${encodeURIComponent(agent.id)}`} aria-label={`打开 ${agent.name} 的聊天`} className="min-w-0 flex-1 rounded-sm focus-visible:ring-2"><h2 className="truncate text-sm font-medium">{agent.name}</h2><p className="mt-0.5 truncate text-xs text-muted-foreground">{syncLabel(agent.sync, !!agent.sync.lastSuccessAt)}{agent.sync.lastSuccessAt ? ` · 最近同步 ${displayTime(agent.sync.lastSuccessAt / 1000)}` : ""}</p></Link><Button asChild size="sm" variant="ghost"><Link href={`/dashboard/connections?agent=${encodeURIComponent(agent.id)}`}>连接设置<ChevronRight className="ml-1 h-3.5 w-3.5" /></Link></Button><AgentConnectionMenu agent={agent} workspace={getCachedAgent(agent.id)} /></article>)}{!filteredAgents.length && <p className="p-4 text-sm text-muted-foreground">没有匹配的连接。</p>}</div>
        </section>}
        {!loading && !loadError && !agents.length && <section aria-labelledby="empty-title" className="rounded-md border border-dashed p-5"><h2 id="empty-title" className="text-sm font-medium">连接你的第一个 agent</h2><p className="mt-1 text-sm text-muted-foreground">让 Hermes 从官网发起连接，在一次性链接中核对授权。</p><div className="mt-3 flex flex-wrap gap-2"><Button asChild size="sm" variant="outline"><Link href="/#start">查看 Hermes 首次接入步骤<ArrowRight className="ml-1 h-3.5 w-3.5" /></Link></Button><Button size="sm" variant="ghost" onClick={() => changeOpen(true)}>已手工安装？添加连接</Button></div></section>}
      </div>

      <DialogContent className="gap-0 rounded-2xl p-0 sm:max-w-[460px]" hideCloseButton={busy} onCloseAutoFocus={(event) => { event.preventDefault(); (dialogOpener.current?.isConnected ? dialogOpener.current : addButton.current)?.focus(); }}>
        <div className="p-6 sm:p-7">
          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/10 text-primary"><Fingerprint className="h-6 w-6" strokeWidth={1.7} aria-hidden="true" /></div>
          <DialogHeader className="text-left"><DialogTitle className="text-xl">手动添加连接</DialogTitle><DialogDescription className="pt-2 text-sm leading-6">适用于已在 agent 所在设备安装连接组件、并取得完整 URN 的情况。首次接入 Hermes 可使用官网自动连接。</DialogDescription></DialogHeader>
          <form onSubmit={connect} className="mt-6 space-y-5" aria-busy={busy}>
            <div className="space-y-2"><label htmlFor="connection-name" className="text-sm font-medium">连接名称</label><Input id="connection-name" maxLength={100} placeholder="例如：我的 Hermes" value={name} onChange={(event) => setName(event.target.value)} className="h-11 rounded-xl" disabled={busy} required /></div>
            <div className="space-y-2">
              <label htmlFor="connection-urn" className="text-sm font-medium">Agent URN</label>
              <Input id="connection-urn" maxLength={256} minLength={10} placeholder="urn:hermes:agent:…" value={urn} onChange={(event) => setUrn(event.target.value)} aria-describedby="urn-hint" className="h-11 rounded-xl font-mono text-base" autoCapitalize="none" autoCorrect="off" spellCheck={false} disabled={busy} required />
              <p id="urn-hint" className="text-xs leading-5 text-muted-foreground">这是 agent 的唯一标识，可从本机 helper 获取。</p>
            </div>
            {formError && <p role="alert" className="flex items-start gap-2 rounded-xl bg-destructive/5 p-3 text-sm leading-6 text-destructive"><CircleAlert className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />{formError}</p>}
            <div className="flex items-start gap-2 rounded-xl bg-muted/60 p-3 text-xs leading-5 text-muted-foreground"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />保存后在本机完成绑定。尚未注册的 agent 会由本机自动注册，并授权网页访问。</div>
            <div className="flex gap-3 pt-1"><Button type="button" variant="outline" onClick={() => changeOpen(false)} disabled={busy} className="h-11 rounded-xl">取消</Button><Button type="submit" disabled={busy} className="h-11 flex-1 gap-2 rounded-xl">{busy ? <><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />保存连接中…</> : <>绑定我的 agent<ArrowRight className="h-4 w-4" aria-hidden="true" /></>}</Button></div>
            <span role="status" className="sr-only">{busy ? "正在保存连接，请稍候。" : ""}</span>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
