"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { NotificationPage, WorkspaceNotification } from "@agent-comm/client-contract";
import { workspaceRequest } from "@/components/workspace-provider";

const empty: NotificationPage = { items: [], unread: 0, pending: 0, before: null, hasMore: false };
type ContextValue = { page: NotificationPage; error: string; refresh: () => Promise<void>; markRead: (item: WorkspaceNotification) => Promise<boolean>;
  enabled: boolean; permission: string; toggleSystem: () => Promise<void> };
const NotificationContext = createContext<ContextValue | null>(null);

export function NotificationProvider({ accountId, children }: { accountId: string; children: React.ReactNode }) {
  const [page, setPage] = useState(empty), [error, setError] = useState("");
  const [enabled, setEnabled] = useState(false), [permission, setPermission] = useState("default");
  const storageKey = `agent-notifications:v1:${accountId}`;
  const device = useRef(""), reading = useRef(false), enabledRef = useRef(false), lifetime = useRef<AbortController>();
  const shown = useRef(new Map<string, Notification>()), processing = useRef(false);
  const attempted = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || reading.current) return;
    reading.current = true;
    try { const value = await workspaceRequest<NotificationPage>("/api/notifications", { signal }); if (!signal.aborted) { setPage(value); setError(""); } }
    catch (failure) { if (!signal.aborted) setError(failure instanceof Error ? failure.message : "提醒暂时无法更新。"); }
    finally { reading.current = false; }
  }, []);
  useEffect(() => {
    const controller = new AbortController(); lifetime.current = controller;
    let timer: ReturnType<typeof setTimeout>, running = true;
    const restore = () => {
      const supported = "Notification" in window && window.isSecureContext;
      setPermission(supported ? Notification.permission : "unsupported");
      try {
        const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
        device.current = typeof saved.deviceId === "string" && /^[a-f0-9-]{36}$/i.test(saved.deviceId) ? saved.deviceId : crypto.randomUUID();
        enabledRef.current = supported && saved.enabled === true && Notification.permission === "granted";
        setEnabled(enabledRef.current);
        localStorage.setItem(storageKey, JSON.stringify({ deviceId: device.current, enabled: enabledRef.current }));
      } catch { device.current = ""; enabledRef.current = false; setEnabled(false); }
    };
    restore();
    const tick = async () => { clearTimeout(timer); await refresh(); if (running) timer = setTimeout(tick, document.hidden ? 15000 : 5000); };
    const resume = () => { restore(); void tick(); };
    window.addEventListener("online", resume); window.addEventListener("storage", restore); document.addEventListener("visibilitychange", resume);
    void tick();
    const displayed = shown.current;
    return () => { running = false; controller.abort(); clearTimeout(timer); window.removeEventListener("online", resume); window.removeEventListener("storage", restore); document.removeEventListener("visibilitychange", resume); for (const notification of Array.from(displayed.values())) notification.close(); displayed.clear(); };
  }, [refresh, storageKey]);

  useEffect(() => {
    // The tab is only a display channel. Server claims coordinate all tabs sharing this device ID.
    for (const [key, notification] of Array.from(shown.current)) {
      const current = page.items.find(item => `${item.agentId}:${item.id}:${item.revision}` === key);
      if (current && (!current.unread || current.state !== "open")) { notification.close(); shown.current.delete(key); }
    }
    if (!enabled || !device.current || !document.hidden || processing.current || Notification.permission !== "granted") return;
    const candidate = page.items.find(item => item.unread && item.systemEligible && item.state === "open" &&
      (item.requiresAction || Date.now() - item.updatedAt < 60000) && !attempted.current.has(`${item.agentId}:${item.id}:${item.revision}`));
    if (!candidate) return;
    const attemptKey = `${candidate.agentId}:${candidate.id}:${candidate.revision}`;
    attempted.current.add(attemptKey);
    processing.current = true;
    const signal = lifetime.current?.signal;
    void workspaceRequest<{ claimed: boolean }>("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "claim", agentId: candidate.agentId, id: candidate.id, revision: candidate.revision, deviceId: device.current }), signal })
      .then(result => {
        if (!result.claimed || signal?.aborted || !enabledRef.current || !document.hidden || Notification.permission !== "granted") return;
        const key = `${candidate.agentId}:${candidate.id}:${candidate.revision}`;
        const notification = new Notification("Agent Comm 协作提醒", { body: candidate.requiresAction ? "有一项协作需要你处理。打开提醒中心核对当前状态。" : "收到新的协作消息。打开提醒中心查看。", tag: `agent-comm:${accountId}:${candidate.agentId}:${candidate.id}` });
        notification.onclick = () => { window.focus(); window.location.assign("/dashboard/notifications"); notification.close(); };
        notification.onclose = () => { shown.current.delete(key); };
        shown.current.set(key, notification);
      }).catch(() => { attempted.current.delete(attemptKey); /* The durable unread item remains available. */ })
      .finally(() => { processing.current = false; });
  }, [accountId, enabled, page]);

  const markRead = useCallback(async (item: WorkspaceNotification) => {
    try {
      await workspaceRequest("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read", agentId: item.agentId, id: item.id, revision: item.revision }), signal: lifetime.current?.signal });
      await refresh();
      return true;
    } catch (failure) { await refresh(); setError(failure instanceof Error ? failure.message : "未能保存已读状态。"); return false; }
  }, [refresh]);
  const toggleSystem = useCallback(async () => {
    if (!("Notification" in window) || !window.isSecureContext) { setPermission("unsupported"); return; }
    try {
      // Permission is requested only in this explicit button handler.
      const nextPermission = enabled ? Notification.permission : await Notification.requestPermission(); setPermission(nextPermission);
      const next = !enabled && nextPermission === "granted";
      const existing = JSON.parse(localStorage.getItem(storageKey) || "{}");
      device.current = existing.deviceId || crypto.randomUUID();
      localStorage.setItem(storageKey, JSON.stringify({ deviceId: device.current, enabled: next }));
      enabledRef.current = next; setEnabled(next);
      if (!next) { for (const notification of Array.from(shown.current.values())) notification.close(); shown.current.clear(); }
    } catch { setError("无法开启此设备的系统提醒，站内提醒仍然可用。"); }
  }, [enabled, storageKey]);
  return <NotificationContext.Provider value={{ page, error, refresh, markRead, enabled, permission, toggleSystem }}>{children}</NotificationContext.Provider>;
}
export function useNotifications() { const context = useContext(NotificationContext); if (!context) throw new Error("NotificationProvider is required"); return context; }
