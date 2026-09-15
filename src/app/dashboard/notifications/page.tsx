"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Bell, BellOff, Check, ExternalLink, RefreshCw } from "lucide-react";
import type { NotificationPage, WorkspaceNotification } from "@agent-comm/client-contract";
import { useNotifications } from "@/components/notification-provider";
import { workspaceRequest } from "@/components/workspace-provider";
import { Button } from "@/components/ui/button";

const time = (value: number) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const statusLabels = { open: "待查看", resolved: "已处理", superseded: "已被更新", expired: "已到期" };

export default function NotificationsPage() {
  const notifications = useNotifications();
  const [filter, setFilter] = useState<"all" | "unread" | "pending">("all");
  const [items, setItems] = useState<WorkspaceNotification[]>([]), [before, setBefore] = useState<number | null>(null);
  const [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const currentFilter = useRef(filter), older = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void workspaceRequest<NotificationPage>(`/api/notifications?filter=${filter}`, { signal: controller.signal }).then(page => {
      if (!controller.signal.aborted) {
        const changed = currentFilter.current !== filter; currentFilter.current = filter;
        if (changed) older.current = false;
        setItems(previous => {
          if (!older.current || changed) return page.items;
          const fresh = new Map(page.items.map(item => [`${item.agentId}:${item.id}`, item]));
          return [...page.items, ...previous.filter(item => !fresh.has(`${item.agentId}:${item.id}`))];
        });
        if (!older.current) setBefore(page.before); setError("");
      }
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [filter, notifications.page]);
  async function loadMore() {
    if (!before || loading) return;
    setLoading(true);
    try {
      const page = await workspaceRequest<NotificationPage>(`/api/notifications?filter=${filter}&before=${before}`);
      older.current = true;
      setItems(previous => { const byId = new Map(previous.map(item => [`${item.agentId}:${item.id}`, item])); for (const item of page.items) byId.set(`${item.agentId}:${item.id}`, item); return Array.from(byId.values()); }); setBefore(page.before);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "无法加载更早的提醒。"); }
    finally { setLoading(false); }
  }
  async function markRead(item: WorkspaceNotification) {
    if (await notifications.markRead(item)) setItems(previous => previous.flatMap(saved => {
      if (saved.agentId !== item.agentId || saved.id !== item.id || saved.revision !== item.revision) return [saved];
      return filter === "unread" ? [] : [{ ...saved, unread: false }];
    }));
  }
  return <div className="mx-auto max-w-4xl space-y-6">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-2xl font-semibold tracking-tight">提醒中心</h1><p className="mt-2 text-sm text-muted-foreground">{notifications.page.unread} 条未读 · {notifications.page.pending} 项待你处理</p></div><Button variant="outline" onClick={() => void notifications.refresh()} className="gap-2"><RefreshCw className="h-4 w-4" />刷新</Button></header>
    <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-card p-5"><div><h2 className="text-sm font-medium">此设备的系统提醒</h2><p className="mt-1 max-w-xl text-xs leading-6 text-muted-foreground">{notifications.background ? "已开启后台推送：关闭页面后也可提醒，需浏览器和系统允许后台通知。推送仅含概括，不含聊天或授权内容。" : "开启后，在页面失去焦点或切换应用时提醒你；支持的浏览器还可开启关闭页面后的后台推送。锁屏仅显示概括。"}</p>{notifications.permission === "denied" && <p className="mt-1 text-xs text-amber-800">浏览器已阻止系统提醒，可在浏览器网站设置中调整。</p>}{notifications.permission === "unsupported" && <p className="mt-1 text-xs text-muted-foreground">当前浏览器或连接不支持系统提醒。</p>}</div><Button variant="outline" disabled={["unsupported", "denied"].includes(notifications.permission)} onClick={() => void notifications.toggleSystem()} className="gap-2">{notifications.enabled ? <BellOff className="h-4 w-4" /> : <Bell className="h-4 w-4" />}{notifications.enabled ? "关闭系统提醒" : "开启系统提醒"}</Button></section>
    <section className="rounded-2xl border bg-card p-5"><div className="flex flex-wrap items-center gap-3"><Button variant="outline" disabled={!notifications.enabled} onClick={() => void notifications.testSystem()}>发送测试提醒</Button>{notifications.enabled && !notifications.background && notifications.pushAvailable && <Button variant="outline" onClick={() => void notifications.enableBackground()}>开启关闭页面后的提醒</Button>}<span className="text-xs text-muted-foreground">{notifications.enabled ? notifications.background ? "后台推送已开启" : "仅页面打开时提醒" : "系统提醒已关闭"}</span></div>{notifications.diagnostic && <p role="status" className="mt-3 text-sm leading-6">{notifications.diagnostic}</p>}<details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">提醒诊断</summary><p className="mt-2 leading-6">浏览器权限：{({ granted: "已允许", denied: "已阻止", default: "尚未允许", unsupported: "不支持" } as Record<string, string>)[notifications.permission] || notifications.permission} · 当前页面：{notifications.away ? "后台或未聚焦" : "前台聚焦"}。测试只检查提醒通道，不会发送协作消息或批准操作。浏览器确认显示请求也不代表用户已经看到横幅；若没有横幅，请检查系统勿扰与网站通知设置。</p></details></section>
    <div role="tablist" aria-label="提醒筛选" className="flex gap-2">{([["all", "全部"], ["unread", "未读"], ["pending", "待我处理"]] as const).map(([value, label]) => <button type="button" role="tab" aria-selected={filter === value} key={value} onClick={() => setFilter(value)} className={`rounded-xl px-4 py-2 text-sm ${filter === value ? "bg-primary text-primary-foreground" : "border bg-card text-muted-foreground"}`}>{label}</button>)}</div>
    {(error || notifications.error) && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{error || notifications.error}</p>}
    {!items.length && <div className="rounded-2xl border border-dashed px-6 py-16 text-center"><Bell className="mx-auto mb-3 h-7 w-7 text-muted-foreground" /><p className="font-medium">{filter === "pending" ? "暂时没有待你处理的事项" : "这里暂时没有提醒"}</p><p className="mt-2 text-sm text-muted-foreground">已授权连接的新消息和待确认事项会自动汇集到这里。</p></div>}
    <div className="space-y-3">{items.map(item => <article key={`${item.agentId}:${item.id}`} className={`rounded-2xl border bg-card p-5 ${item.requiresAction ? "border-amber-200" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="text-xs text-muted-foreground">{item.agentName}</span>{item.unread && <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary">未读</span>}</div><span className={`text-xs ${item.requiresAction ? "text-amber-800" : "text-muted-foreground"}`}>{item.requiresAction ? "待你处理" : statusLabels[item.state]}</span></div>
      <h2 className="mt-3 break-words font-medium">{item.title || "协作提醒"}</h2><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-7 text-muted-foreground">{item.summary}</p>
      <p className="mt-3 text-[11px] leading-6 text-muted-foreground">最近同步 {time(item.observedAt)}{item.expiresAt !== null && <> · 截止 {time(item.expiresAt)}</>}{item.source === "snapshot" && " · 来自已保存快照"}</p>
      {["offline", "needs_pairing"].includes(item.sync.status) && <p className="mt-1 text-xs text-amber-800">当前连接尚未核实，显示上次同步的状态。处理前请回到 agent 核对。</p>}
      {item.requiresAction && <p className="mt-2 text-xs leading-6 text-amber-800">请在 agent 原生渠道核对并决定。标记已读只更新提醒。</p>}
      <div className="mt-4 flex flex-wrap gap-2"><Button asChild size="sm" className="gap-2"><Link href={item.href}><ExternalLink className="h-3.5 w-3.5" />查看当前事项</Link></Button>{item.unread && <Button variant="outline" size="sm" className="gap-2" onClick={() => void markRead(item)}><Check className="h-3.5 w-3.5" />标记已读</Button>}</div>
    </article>)}</div>
    {before !== null && <div className="text-center"><Button variant="outline" disabled={loading} onClick={() => void loadMore()}>{loading ? "正在加载…" : "更早的提醒"}</Button></div>}
  </div>;
}
