"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { Cable, ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useLocalTime } from "@/components/local-time";
import { canOpenWorkspaceNode, workspaceNodeStatus, workspaceScopeLabels, type WorkspaceNode, mergeWorkspaceNodePage } from "@/lib/workspace-nodes/model";

class PortalRequestError extends Error {
  constructor(message: string, public retryAfter = 0) { super(message); }
}
// All node operations in this browser respect the same account's Gateway cooldown.
const gatewayCooldown = new Map<string, number>();

async function portalRequest<T>(accountId: string, path: string, method = "GET", body?: object, signal?: AbortSignal): Promise<T> {
  const remaining = Math.ceil(((gatewayCooldown.get(accountId) || 0) - Date.now()) / 1000);
  if (remaining > 0) throw new PortalRequestError(`请等待 ${remaining} 秒后重试工作区入口。`, remaining);
  gatewayCooldown.delete(accountId);
  const response = await fetch(path, { method, cache: "no-store", signal,
    headers: { "Content-Type": "application/json", "X-Workspace-Account": accountId },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const header = response.headers.get("retry-after") || "";
    const retryAfter = response.status === 429 ? (/^[1-9]\d{0,2}$/.test(header) && Number(header) <= 300 ? Number(header) : 60) : 0;
    if (retryAfter) gatewayCooldown.set(accountId, Date.now() + retryAfter * 1000);
    throw new PortalRequestError(response.status === 401 ? "登录已失效，请重新登录后打开原连接链接。"
    : response.status === 409 && value.error === "ACCOUNT_CHANGED" ? "登录账户已改变，请刷新页面后核对账户。"
    : value.error || "连接请求未完成，请重新读取状态。", retryAfter);
  }
  return value as T;
}

function NodeDetails({ node }: { node: WorkspaceNode }) {
  const displayTime = useLocalTime();
  return <dl className="grid gap-3 text-sm sm:grid-cols-2">
    <div><dt className="text-muted-foreground">账户</dt><dd className="mt-1 break-all">{node.account_label || "尚未领取"}</dd></div>
    <div><dt className="text-muted-foreground">授权到期</dt><dd className="mt-1">{displayTime(node.expires_at, { style: "full" })}</dd></div>
    <div className="sm:col-span-2"><dt className="text-muted-foreground">本机申请的范围</dt><dd className="mt-1">{node.scopes.map(scope => workspaceScopeLabels[scope]).join("；")}</dd></div>
  </dl>;
}

type Enrollment = { enrollment_token: string; expires_at: string; gateway_url: string };
export function WorkspaceEnrollment({ accountId, accountLabel }: { accountId: string; accountLabel: string }) {
  const [enrollment, setEnrollment] = useState<Enrollment>(), [busy, setBusy] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const generating = useRef(false);
  const [coolingDown, setCoolingDown] = useState(false);
  const displayTime = useLocalTime();
  useEffect(() => {
    if (!enrollment) return;
    const expire = () => {
      if (Date.parse(enrollment.expires_at) <= Date.now()) {
        setEnrollment(undefined); setNotice("接入码已到期。需要时点击生成新码。");
      }
    };
    const timer = setInterval(expire, 1000); expire();
    return () => clearInterval(timer);
  }, [enrollment]);
  useEffect(() => {
    if (!coolingDown) return;
    const timer = setTimeout(() => setCoolingDown(false), Math.max(0, (gatewayCooldown.get(accountId) || 0) - Date.now()));
    return () => clearTimeout(timer);
  }, [accountId, coolingDown]);
  async function generate() {
    if (generating.current || coolingDown) return;
    generating.current = true; setBusy(true); setError(""); setNotice(""); setEnrollment(undefined);
    try { setEnrollment(await portalRequest<Enrollment>(accountId, "/api/workspace-nodes/enroll", "POST", {})); }
    catch (cause) {
      setError(cause instanceof Error ? cause.message : "接入码未确认，请稍后重新操作。");
      if (cause instanceof PortalRequestError && cause.retryAfter) setCoolingDown(true);
    }
    finally { generating.current = false; setBusy(false); }
  }
  async function copy(value: string, label: string) {
    if (!enrollment || Date.parse(enrollment.expires_at) <= Date.now()) { setEnrollment(undefined); setNotice("接入码已到期。"); return; }
    try { await navigator.clipboard.writeText(value); setNotice(label + "已复制。"); }
    catch { setNotice("复制未完成，请选中字段手动复制。"); }
  }
  return <section className="rounded-2xl border bg-card p-5 sm:p-6" aria-labelledby="workspace-enrollment-title">
    <h2 id="workspace-enrollment-title" className="text-lg font-semibold">生成本机接入码</h2>
    <p className="mt-2 text-sm leading-6 text-muted-foreground">当前账户：<span className="font-medium text-foreground">{accountLabel}</span>。先生成接入码，再把它和入口地址粘贴到你电脑上的 Ambient“远程连接”。</p>
    <Button className="mt-4" onClick={() => void generate()} disabled={busy || !!enrollment || coolingDown}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{busy ? "生成中…" : coolingDown ? "请稍后生成" : "生成本机接入码"}</Button>
    {enrollment && <div className="mt-4 space-y-3">
      <div><label htmlFor="workspace-enrollment-token" className="text-sm font-medium">一次性接入码</label><div className="mt-1 flex flex-col gap-2 sm:flex-row"><Input id="workspace-enrollment-token" readOnly value={enrollment.enrollment_token} autoComplete="off" spellCheck={false} /><Button variant="outline" onClick={() => void copy(enrollment.enrollment_token, "接入码")}>复制接入码</Button></div></div>
      <div><label htmlFor="workspace-gateway-public" className="text-sm font-medium">Ambient 入口地址</label><div className="mt-1 flex flex-col gap-2 sm:flex-row"><Input id="workspace-gateway-public" readOnly value={enrollment.gateway_url} /><Button variant="outline" onClick={() => void copy(enrollment.gateway_url, "入口地址")}>复制入口地址</Button></div></div>
      <p className="text-sm leading-6">接入码到期：{displayTime(enrollment.expires_at, { style: "full" })}。有效 5 分钟，只能使用一次；生成接入码尚未连接工作区。</p>
      <Button variant="ghost" onClick={() => { setEnrollment(undefined); setNotice("已隐藏接入码。旧码仍会按原期限到期；需要新码请明确生成。"); }}>隐藏接入码</Button>
    </div>}
    <p className="mt-3 text-xs leading-5 text-muted-foreground">Ambient 使用接入码创建申请后，仍需在下方以当前账户领取它返回的连接码，并回到本机确认范围和期限。请勿把接入码分享给他人。刷新会清除本页显示，不会自动生成新码。</p>
    {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="mt-3 text-sm text-muted-foreground">{notice}</p>}
  </section>;
}

export function WorkspaceClaim({ accountId, accountLabel, initialCode = "" }: { accountId: string; accountLabel: string; initialCode?: string }) {
  const [code, setCode] = useState(initialCode), [node, setNode] = useState<WorkspaceNode>();
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function claim(event: React.FormEvent) {
    event.preventDefault(); if (busy) return;
    setBusy(true); setError("");
    try { setNode(await portalRequest<WorkspaceNode>(accountId, "/api/workspace-nodes/claim", "POST", { code: code.trim() })); setCode(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "领取未完成，请重新读取连接状态。"); }
    finally { setBusy(false); }
  }
  return <section className="rounded-2xl border bg-card p-5 sm:p-6" aria-labelledby="workspace-claim-title">
    <h2 id="workspace-claim-title" className="text-lg font-semibold">{node ? "连接已领取，等待本机确认" : "连接你的 Ambient 工作区"}</h2>
    <p className="mt-2 text-sm leading-6 text-muted-foreground">当前账户：<span className="font-medium text-foreground">{accountLabel}</span>。仅领取你在自己的电脑上刚刚发起的连接。</p>
    {node ? <div className="mt-5 space-y-4"><p className="font-medium">{node.name}</p><NodeDetails node={node} /><p className="rounded-xl bg-muted p-3 text-sm leading-6">回到 Ambient 本机，核对账户、权限范围和期限，再确认连接。领取一次性码尚未授予远程访问权。</p><Button asChild variant="outline"><Link href="/dashboard/workspaces">查看连接状态</Link></Button></div>
      : <form onSubmit={claim} className="mt-4 space-y-3"><label htmlFor="workspace-code" className="block text-sm font-medium">本机生成的一次性连接码</label><div className="flex flex-col gap-3 sm:flex-row"><Input id="workspace-code" value={code} onChange={event => setCode(event.target.value)} autoComplete="off" spellCheck={false} maxLength={128} placeholder="粘贴连接码" disabled={busy} required /><Button type="submit" disabled={busy || !code.trim()} className="shrink-0">{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}以当前账户领取</Button></div><p className="text-xs leading-5 text-muted-foreground">领取后，电脑上的 Ambient 仍需你亲自确认。打开此页面不会自动连接或启动任务。</p></form>}
    {error && <p role="alert" className="mt-4 text-sm text-destructive">{error}</p>}
  </section>;
}

export function WorkspaceNodes({ accountId, accountLabel }: { accountId: string; accountLabel: string }) {
  const [nodes, setNodes] = useState<WorkspaceNode[]>([]), [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState("");
  const [view, setView] = useState<"active" | "history">("active");
  const [nextCursor, setNextCursor] = useState<string | null>(null), [loadingPage, setLoadingPage] = useState(false);
  const paginated = useRef(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const readVersion = useRef(0), working = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (working.current || paginated.current) return;
    const version = ++readVersion.current;
    try {
      const value = await portalRequest<{ nodes: WorkspaceNode[]; next_cursor: string | null }>(accountId, "/api/workspace-nodes?view=" + view, "GET", undefined, signal);
      if (!signal?.aborted && readVersion.current === version) { setNodes(value.nodes); setNextCursor(value.next_cursor); setError(""); setLoaded(true); }
    } catch (cause) {
      if (!signal?.aborted && readVersion.current === version) { setError(cause instanceof Error ? cause.message : "暂时无法读取连接。"); setLoaded(true); }
    }
  }, [accountId, view]);
  useEffect(() => {
    paginated.current = false; readVersion.current++; setNodes([]); setLoaded(false); setNextCursor(null);
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => { await refresh(controller.signal); if (!controller.signal.aborted) timer = setTimeout(poll, document.hidden ? 30000 : 5000); };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);
  async function loadMore() {
    if (working.current || !nextCursor) return;
    working.current = true; paginated.current = true; const version = ++readVersion.current;
    setLoadingPage(true); setError("");
    try {
      const query = new URLSearchParams({ view, cursor: nextCursor });
      const value = await portalRequest<{ nodes: WorkspaceNode[]; next_cursor: string | null }>(accountId, "/api/workspace-nodes?" + query);
      if (version === readVersion.current) { setNodes(previous => mergeWorkspaceNodePage(previous, value.nodes)); setNextCursor(value.next_cursor); }
    } catch (cause) { if (version === readVersion.current) setError(cause instanceof Error ? cause.message : "下一页未读取完成。"); }
    finally { working.current = false; setLoadingPage(false); }
  }
  async function act(node: WorkspaceNode, action: "open" | "revoke") {
    if (working.current) return;
    working.current = true; readVersion.current++; setBusy(node.node_id); setError(""); setNotice("");
    try {
      const path = `/api/workspace-nodes/${encodeURIComponent(node.node_id)}`;
      if (action === "open") {
        const launch = await portalRequest<{ url: string }>(accountId, path + "/open", "POST", {});
        window.location.assign(launch.url);
      } else {
        const revoked = await portalRequest<WorkspaceNode>(accountId, path, "DELETE", {});
        setNodes(previous => previous.map(item => item.node_id === node.node_id ? revoked : item));
        setConfirmRevoke(null); setNotice("已撤销连接，远程工作区访问已停止。");
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : "操作未确认，请重新读取状态。"); }
    finally { working.current = false; setBusy(""); }
  }
  return <div className="space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">本地工作区</h1><p className="mt-2 text-sm leading-6 text-muted-foreground">从这里打开你电脑上的 Ambient。保持电脑开机并联网，任务仍由本机执行。</p></div><Button variant="outline" size="sm" onClick={() => { paginated.current = false; void refresh(); }} disabled={!!busy || loadingPage}><RefreshCw className="mr-2 h-4 w-4" />重新读取</Button></header>
    <p className="rounded-xl border bg-muted/40 p-3 text-sm leading-6 text-muted-foreground">工作区通过独立中转服务连接。中转服务能读取传输内容，不保存正文副本；访问范围和期限由你在 Ambient 本机确认，聊天平台的政策与暂停只管理聊天控制和同步。</p>
    <WorkspaceEnrollment accountId={accountId} accountLabel={accountLabel} />
    <WorkspaceClaim accountId={accountId} accountLabel={accountLabel} />
    <section aria-labelledby="workspace-nodes-title" className="space-y-3"><h2 id="workspace-nodes-title" className="text-base font-semibold">我的工作区连接</h2>
      <div className="flex gap-2"><Button variant={view === "active" ? "default" : "outline"} disabled={!!busy || loadingPage} onClick={() => setView("active")}>当前连接</Button><Button variant={view === "history" ? "default" : "outline"} disabled={!!busy || loadingPage} onClick={() => setView("history")}>已撤销与到期</Button></div>
      {!loaded && <p className="text-sm text-muted-foreground">正在读取连接…</p>}
      {loaded && !nodes.length && !error && <p className="rounded-2xl border p-5 text-sm text-muted-foreground">{view === "history" ? "暂无已撤销或到期的连接。" : "尚无当前连接。先生成本机接入码，再在 Ambient 中创建申请并在这里领取连接码。"}</p>}
      {nodes.map(node => <article key={node.node_id} className="rounded-2xl border bg-card p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-3"><h3 className="flex items-center gap-2 font-semibold"><Cable className="h-4 w-4 text-primary" />{node.name}</h3><span className="rounded-full bg-muted px-3 py-1 text-xs">{workspaceNodeStatus(node)}</span></div>
        <NodeDetails node={node} />
        {node.status === "pending" && <p className="mt-4 text-sm leading-6 text-muted-foreground">Ambient 已创建申请。请在上方填写本机返回的连接码，以当前账户明确领取，再回到本机确认。</p>}
        {node.status === "claimed" && <p className="mt-4 text-sm leading-6 text-muted-foreground">请回到 Ambient 本机确认此账户、权限与期限。完成确认并联网后才能打开工作区。</p>}
        {node.status === "paired" && !node.online && <p className="mt-4 text-sm text-muted-foreground">本机暂时离线。保持 Ambient 运行，联网后这里会自动更新。</p>}
        <div className="mt-5 flex flex-wrap gap-3"><Button onClick={() => void act(node, "open")} disabled={!!busy || loadingPage || !canOpenWorkspaceNode(node)}><ExternalLink className="mr-2 h-4 w-4" />{busy === node.node_id ? "处理中…" : "打开工作区"}</Button>
          {node.status !== "revoked" && (confirmRevoke === node.node_id ? <div className="flex flex-wrap items-center gap-2"><span className="text-sm">停止此工作区的远程访问？</span><Button variant="destructive" disabled={!!busy || loadingPage} onClick={() => void act(node, "revoke")}>确认撤销</Button><Button variant="ghost" disabled={!!busy || loadingPage} onClick={() => setConfirmRevoke(null)}>保留连接</Button></div>
            : <Button variant="outline" disabled={!!busy || loadingPage} onClick={() => setConfirmRevoke(node.node_id)}>撤销连接</Button>)}</div>
      </article>)}
      {nextCursor && <Button variant="outline" onClick={() => void loadMore()} disabled={!!busy || loadingPage}>{loadingPage ? "正在读取…" : "加载更多连接"}</Button>}
      {paginated.current && <p className="text-xs leading-5 text-muted-foreground">已读取多页，自动刷新暂停。点击“重新读取”返回最新一页；本页最多显示最近载入的 500 个连接。</p>}
    </section>
    {error && <p role="alert" className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{error}</p>}
    {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
  </div>;
}
