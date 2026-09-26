"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, Bot, Check, ChevronRight, CircleAlert, Fingerprint, Inbox, Loader2, MessageSquare, Plus, RefreshCw, Search, ShieldCheck, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

import { useWorkspace } from "@/components/workspace-provider";
import { syncLabel } from "@/lib/workspace/workspace-client";
import { useLocalTime } from "@/components/local-time";

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
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" role="status" aria-label="正在加载连接">
      {[0, 1, 2].map((index) => (
        <div key={index} className="rounded-2xl border bg-card p-6 motion-safe:animate-pulse" aria-hidden="true">
          <div className="mb-6 h-12 w-12 rounded-2xl bg-muted" />
          <div className="h-5 w-2/3 rounded-md bg-muted" />
          <div className="mt-3 h-3 w-full rounded-md bg-muted" />
          <div className="mt-7 border-t pt-4"><div className="h-4 w-24 rounded-md bg-muted" /></div>
        </div>
      ))}
      <span className="sr-only">正在加载你的连接…</span>
    </div>
  );
}

export default function AgentsPage() {
  const displayTime = useLocalTime();
  const router = useRouter();
  const { connections: agents, loading, error: loadError, refresh: load, requestSync } = useWorkspace();
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
      router.push(`/dashboard/agents/${data.id}`);
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
      <div className="mx-auto w-full max-w-6xl space-y-8 pb-6">
        <header className="flex flex-wrap items-start justify-between gap-5">
          <div>
            <p className="mb-2 text-xs font-medium tracking-widest text-muted-foreground">你的工作空间</p>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-semibold tracking-tight sm:text-[2rem]">我的连接</h1>
              {!loading && !loadError && <span className="rounded-lg border bg-card px-2.5 py-0.5 text-sm font-medium tabular-nums text-muted-foreground" aria-label={`${agents.length} 个连接`}>{agents.length}</span>}
            </div>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">连接你的本机 agent；网页会自动同步 agent 的消息、联系人和处理状态。</p>
          </div>
          <DialogTrigger asChild>
            <Button ref={addButton} className="gap-2 rounded-xl shadow-sm sm:mt-6"><Plus className="h-4 w-4" aria-hidden="true" />添加连接</Button>
          </DialogTrigger>
        </header>

        {success && <div role="status" className="flex items-center gap-2 rounded-xl border border-primary/20 bg-primary/5 px-4 py-3 text-sm text-primary"><Check className="h-4 w-4 shrink-0" aria-hidden="true" />{success}</div>}

        {loadError && (
          <div role="alert" className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-destructive/20 bg-destructive/5 p-5">
            <div className="flex items-start gap-3">
              <CircleAlert className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden="true" />
              <div><p className="text-sm font-medium">暂时无法更新连接</p><p className="mt-1 text-sm text-muted-foreground">{loadError}</p></div>
            </div>
            <Button variant="outline" className="gap-2 rounded-xl" onClick={() => void load()} disabled={loading}><RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} aria-hidden="true" />重试</Button>
          </div>
        )}

        {loading && !agents.length && <ConnectionSkeleton />}

        {!!agents.length && (
          <section aria-label="已保存的连接" className="space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-sm"><span className="font-medium">所有连接</span><span className="text-muted-foreground" aria-live="polite">{search ? `${filteredAgents.length} 个匹配` : `${agents.length} 个已保存`}</span></div>
              <div className="relative w-full sm:w-72">
                <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
                <Input ref={searchInput} type="search" aria-label="搜索连接名称或 URN" placeholder="搜索名称或 URN…" value={query} onChange={(event) => setQuery(event.target.value)} className="rounded-xl bg-card pl-9 pr-10 [&::-webkit-search-cancel-button]:appearance-none" />
                {query && <Button size="icon" variant="ghost" aria-label="清空搜索" className="absolute right-1 top-1 h-8 w-8 rounded-lg" onClick={() => { setQuery(""); searchInput.current?.focus(); }}><X className="h-3.5 w-3.5" aria-hidden="true" /></Button>}
              </div>
            </div>
            {filteredAgents.length ? (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {filteredAgents.map((agent) => (
                  <Link key={agent.id} href={`/dashboard/agents/${agent.id}`} aria-label={`打开 ${agent.name} 的远程工作台`} className="group flex min-w-0 flex-col rounded-2xl border bg-card p-5 shadow-sm transition-[transform,box-shadow,border-color] duration-200 hover:border-primary/30 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4 motion-safe:hover:-translate-y-1 sm:p-6">
                    <div className="mb-5 flex items-start justify-between">
                      <div className={`flex h-12 w-12 items-center justify-center rounded-2xl ${avatarColor(agent.id)}`}><Bot className="h-6 w-6" strokeWidth={1.6} aria-hidden="true" /></div>
                      <span className="flex h-8 w-8 items-center justify-center rounded-full bg-muted/60 text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary"><ArrowRight className="h-4 w-4 transition-transform motion-safe:group-hover:-rotate-45" aria-hidden="true" /></span>
                    </div>
                    <h2 className="truncate text-lg font-semibold tracking-tight" title={agent.name}>{agent.name}</h2>
                    <p className="mt-2 truncate font-mono text-xs leading-5 text-muted-foreground" title={agent.urn}>{agent.urn}</p>
                    <div className="mt-5 flex items-center justify-between border-t pt-4 text-xs"><span className="min-w-0 pr-2 text-muted-foreground"><span className="block">{syncLabel(agent.sync, !!agent.sync.lastSuccessAt)}</span>{agent.sync.lastSuccessAt && <span className="mt-1 block text-xs">最近同步 {displayTime(agent.sync.lastSuccessAt / 1000)}</span>}</span><span className="flex items-center gap-1 font-medium text-primary">打开<ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></span></div>
                  </Link>
                ))}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed bg-card/60 px-6 py-16 text-center">
                <Search className="mx-auto h-7 w-7 text-muted-foreground/60" aria-hidden="true" />
                <h2 className="mt-4 font-medium">没有找到匹配的连接</h2>
                <p className="mt-2 text-sm text-muted-foreground">试试其他名称，或使用完整 URN 搜索。</p>
                <Button variant="outline" className="mt-5 rounded-xl" onClick={() => { setQuery(""); searchInput.current?.focus(); }}>清空搜索</Button>
              </div>
            )}
          </section>
        )}

        {!loading && !loadError && !agents.length && (
          <section className="overflow-hidden rounded-3xl border bg-card shadow-sm" aria-labelledby="empty-title">
            <div className="relative flex flex-col items-center px-6 pb-12 pt-12 text-center sm:pb-14 sm:pt-14">
              <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(ellipse_at_top,hsl(var(--primary)/0.08),transparent_70%)]" aria-hidden="true" />
              <div className="relative mb-8 flex h-32 w-full max-w-64 items-center justify-center" aria-hidden="true">
                <div className="absolute h-32 w-32 rounded-full border border-primary/10" />
                <div className="absolute h-24 w-24 rounded-full border border-primary/15 bg-primary/[0.03]" />
                <div className="absolute left-1 top-8 flex h-12 w-12 -rotate-12 items-center justify-center rounded-2xl border bg-card text-muted-foreground shadow-sm"><MessageSquare className="h-5 w-5" strokeWidth={1.5} /></div>
                <div className="absolute bottom-6 right-1 flex h-12 w-12 rotate-12 items-center justify-center rounded-2xl border bg-card text-muted-foreground shadow-sm"><Inbox className="h-5 w-5" strokeWidth={1.5} /></div>
                <div className="relative flex h-16 w-16 items-center justify-center rounded-[1.3rem] bg-primary text-primary-foreground shadow-[0_8px_24px_hsl(var(--primary)/0.2)]"><Bot className="h-8 w-8" strokeWidth={1.5} /></div>
              </div>
              <h2 id="empty-title" className="relative text-xl font-semibold tracking-tight sm:text-2xl">连接你的第一个 agent</h2>
              <p className="relative mt-3 max-w-sm text-sm leading-7 text-muted-foreground">让已经能正常使用的 Hermes 从官网发起连接，<br className="hidden sm:block" />在网页核对授权后，它会自动出现在这里。</p>
              <Button asChild className="relative mt-7 h-11 gap-2 rounded-xl px-6"><Link href="/#start">查看 Hermes 首次接入步骤<ArrowRight className="ml-1 h-4 w-4" aria-hidden="true" /></Link></Button>
              <Button variant="ghost" onClick={() => changeOpen(true)} className="relative mt-2 h-11 rounded-xl text-sm">已手工安装？添加连接</Button>
            </div>
            <div className="border-t bg-muted/30 px-6 py-6 sm:px-8">
              <ol className="grid gap-5 md:grid-cols-3">
                {[
                  { title: "让 Hermes 发起连接", detail: "让 Hermes 按官网指南安装并提供一次性链接" },
                  { title: "在网页确认授权", detail: "核对 agent、功能和期限，连接会自动加入" },
                  { title: "检查真实回复", detail: "本机配对完成后，发送测试消息并等待答复" },
                ].map((step, index) => (
                  <li key={step.title} className="flex items-start gap-3"><span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-card text-xs font-medium text-muted-foreground">{index + 1}</span><div><p className="text-xs font-medium leading-6">{step.title}</p><p className="mt-0.5 text-xs leading-5 text-muted-foreground">{step.detail}</p></div></li>
                ))}
              </ol>
            </div>
          </section>
        )}
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
