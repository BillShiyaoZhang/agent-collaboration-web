"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { NotificationPage, WorkspaceNotification } from "@agent-comm/client-contract";
import { workspaceRequest } from "@/components/workspace-provider";
import { applicationServerKey, bindBrowserPush, browserIsAway, browserPushTransition, clearBrowserPush, PUSH_OWNER_KEY, pushRegistration, pushWorkerMessage, supportsBackgroundPush, type PushSettings } from "@/lib/notifications/browser-push";

const empty: NotificationPage = { items: [], unread: 0, pending: 0, before: null, hasMore: false };
type ContextValue = { page: NotificationPage; error: string; refresh: () => Promise<void>; markRead: (item: WorkspaceNotification) => Promise<boolean>;
  enabled: boolean; permission: string; toggleSystem: () => Promise<void>; enableBackground: () => Promise<void>; disableSystem: () => Promise<void>;
  background: boolean; pushAvailable: boolean; away: boolean; diagnostic: string; testSystem: () => Promise<void> };
const NotificationContext = createContext<ContextValue | null>(null);

export function NotificationProvider({ accountId, children }: { accountId: string; children: React.ReactNode }) {
  const [page, setPage] = useState(empty), [error, setError] = useState("");
  const [enabled, setEnabled] = useState(false), [permission, setPermission] = useState("default");
  const [background, setBackground] = useState(false), [pushAvailable, setPushAvailable] = useState(false), [away, setAway] = useState(false), [diagnostic, setDiagnostic] = useState("");
  const pushRef = useRef(false), lastPushRefresh = useRef(0), pushRefreshing = useRef(false);
  const pushGeneration = useRef(0);
  const storageKey = `agent-notifications:v1:${accountId}`;
  const device = useRef(""), reading = useRef(false), enabledRef = useRef(false), lifetime = useRef<AbortController>();
  const shown = useRef(new Map<string, Notification>()), processing = useRef(false);
  const attempted = useRef(new Set<string>());
  const pushRequest = useCallback(<T,>(body: Record<string, unknown>) => workspaceRequest<T>("/api/notifications/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: lifetime.current?.signal }), []);
  const refreshPush = useCallback(async () => {
    if (!device.current || !supportsBackgroundPush() || pushRefreshing.current || Date.now() - lastPushRefresh.current < 10000) return;
    pushRefreshing.current = true; lastPushRefresh.current = Date.now();
    const generation = pushGeneration.current, signal = lifetime.current?.signal;
    try {
      const settings = await workspaceRequest<PushSettings>(`/api/notifications/push?deviceId=${encodeURIComponent(device.current)}`, { signal });
      if (signal?.aborted || generation !== pushGeneration.current) return;
      if (settings.accountId !== accountId) { pushRef.current = false; setBackground(false); throw new Error("登录账号已变化，请刷新页面。"); }
      setPushAvailable(settings.available);
      const active = await browserPushTransition(async () => {
        if (signal?.aborted || generation !== pushGeneration.current) return false;
        if (settings.subscription && !enabledRef.current) { await clearBrowserPush(); await workspaceRequest("/api/notifications/push", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "revoke", deviceId: device.current }), signal }); }
        const registration = await pushRegistration(), browserSubscription = await registration?.pushManager.getSubscription();
        if (signal?.aborted || generation !== pushGeneration.current) return false;
        const bound = enabledRef.current && settings.available && !!settings.subscription && !!browserSubscription;
        if (bound) {
          await bindBrowserPush(settings, accountId);
          if (signal?.aborted || generation !== pushGeneration.current) { await clearBrowserPush(); return false; }
          void pushWorkerMessage({ action: "reconcile" }, registration).catch(() => {});
        }
        return bound;
      });
      if (signal?.aborted || generation !== pushGeneration.current) return;
      pushRef.current = active; setBackground(active);
      const labels: Record<string, string> = { pending: "推送已排队", sending: "正在联系浏览器推送服务", sent: "推送服务已接收，等待浏览器回执", received: "浏览器已收到推送", deferred: "页面在前台，离开后会在有效期内继续尝试提醒", displayed: "浏览器已接受显示请求；是否弹出横幅由系统设置决定", suppressed: "此设备已处理该提醒", expired: "提醒已过期或状态已更新", failed: "推送未能送达，请重新开启或稍后测试", display_error: "浏览器未接受显示请求，请检查网站通知权限" };
      if (settings.lastDelivery) setDiagnostic(labels[settings.lastDelivery.status] || "推送状态已更新");
      else if (!settings.available) setDiagnostic("服务器尚未启用后台推送；页面打开时的提醒仍可使用。");
      else if (enabledRef.current && !active) setDiagnostic("当前仅在页面打开时提醒。可开启后台推送，关闭页面后继续接收。");
    } catch (failure) { if (!lifetime.current?.signal.aborted) setDiagnostic(failure instanceof Error ? failure.message : "无法读取后台推送状态。"); }
    finally { pushRefreshing.current = false; }
  }, [accountId]);
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
        const nextEnabled = supported && saved.enabled === true && Notification.permission === "granted";
        if (enabledRef.current !== nextEnabled) pushGeneration.current++;
        enabledRef.current = nextEnabled;
        setEnabled(enabledRef.current);
        localStorage.setItem(storageKey, JSON.stringify({ deviceId: device.current, enabled: enabledRef.current }));
      } catch { device.current = ""; enabledRef.current = false; setEnabled(false); }
    };
    restore();
    void (async () => { try { await browserPushTransition(async () => { if (controller.signal.aborted) return; const previous = localStorage.getItem(PUSH_OWNER_KEY); if (previous && previous !== accountId) await clearBrowserPush(); }); } catch {} await refreshPush(); })();
    const tick = async () => { clearTimeout(timer); await refresh(); await refreshPush(); if (running) timer = setTimeout(tick, document.hidden ? 15000 : 5000); };
    const resume = () => { restore(); void tick(); };
    window.addEventListener("online", resume); window.addEventListener("storage", restore); document.addEventListener("visibilitychange", resume);
    void tick();
    const displayed = shown.current;
    return () => { running = false; controller.abort(); clearTimeout(timer); window.removeEventListener("online", resume); window.removeEventListener("storage", restore); document.removeEventListener("visibilitychange", resume); for (const notification of Array.from(displayed.values())) notification.close(); displayed.clear(); };
  }, [accountId, refresh, refreshPush, storageKey]);

  useEffect(() => {
    let wasFocused = false;
    const update = () => { const next = browserIsAway(document.hidden, document.hasFocus()); setAway(next); if (pushRef.current && device.current && (!next || wasFocused)) void pushRequest({ action: "presence", deviceId: device.current, focused: !next }).catch(() => {}); wasFocused = !next; };
    const message = (event: MessageEvent) => { if (event.data?.type === "agent-comm-attention-refresh") void refresh(); };
    update(); const timer = setInterval(() => { if (!browserIsAway(document.hidden, document.hasFocus())) update(); }, 10000);
    window.addEventListener("focus", update); window.addEventListener("blur", update); document.addEventListener("visibilitychange", update);
    navigator.serviceWorker?.addEventListener("message", message);
    return () => { clearInterval(timer); window.removeEventListener("focus", update); window.removeEventListener("blur", update); document.removeEventListener("visibilitychange", update); navigator.serviceWorker?.removeEventListener("message", message); };
  }, [background, pushRequest, refresh]);

  useEffect(() => {
    // The tab is only a display channel. Server claims coordinate all tabs sharing this device ID.
    for (const [key, notification] of Array.from(shown.current)) {
      const current = page.items.find(item => `${item.agentId}:${item.id}:${item.revision}` === key);
      if (current && (!current.unread || current.state !== "open")) { notification.close(); shown.current.delete(key); }
    }
    if (!enabled || background || !device.current || !away || processing.current || Notification.permission !== "granted") return;
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
        if (!result.claimed || signal?.aborted || !enabledRef.current || pushRef.current || !browserIsAway(document.hidden, document.hasFocus()) || Notification.permission !== "granted") return;
        const key = `${candidate.agentId}:${candidate.id}:${candidate.revision}`;
        const notification = new Notification("Agent Comm 协作提醒", { body: candidate.requiresAction ? "有一项协作需要你处理。打开提醒中心核对当前状态。" : "收到新的协作消息。打开提醒中心查看。", tag: `agent-comm:${accountId}:${candidate.agentId}:${candidate.id}` });
        notification.onclick = () => { window.focus(); window.location.assign("/dashboard/notifications"); notification.close(); };
        notification.onclose = () => { shown.current.delete(key); };
        shown.current.set(key, notification);
      }).catch(() => { attempted.current.delete(attemptKey); /* The durable unread item remains available. */ })
      .finally(() => { processing.current = false; });
  }, [accountId, away, background, enabled, page]);

  const markRead = useCallback(async (item: WorkspaceNotification) => {
    try {
      await workspaceRequest("/api/notifications", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "read", agentId: item.agentId, id: item.id, revision: item.revision }), signal: lifetime.current?.signal });
      await refresh();
      return true;
    } catch (failure) { await refresh(); setError(failure instanceof Error ? failure.message : "未能保存已读状态。"); return false; }
  }, [refresh]);
  const disableSystem = useCallback(async () => {
    pushGeneration.current++;
    enabledRef.current = false; pushRef.current = false; setEnabled(false); setBackground(false);
    try { localStorage.setItem(storageKey, JSON.stringify({ deviceId: device.current, enabled: false })); } catch {}
    for (const notification of Array.from(shown.current.values())) notification.close(); shown.current.clear();
    // Clear the worker first: a queued push cannot display after local opt-out.
    await browserPushTransition(async () => {
      try { await clearBrowserPush(); } catch { setDiagnostic("浏览器订阅清理暂未完成，可在网站设置中撤销通知权限。"); }
      try { if (device.current) await pushRequest({ action: "revoke", deviceId: device.current }); } catch { setDiagnostic("此设备已停止提醒；服务器订阅撤销暂未确认，恢复网络后可再次关闭。"); }
    });
  }, [pushRequest, storageKey]);
  const enableBackground = useCallback(async () => {
    if (!supportsBackgroundPush() || Notification.permission !== "granted") return;
    const generation = ++pushGeneration.current, signal = lifetime.current?.signal;
    const current = () => generation === pushGeneration.current && enabledRef.current && !signal?.aborted;
    try {
      await browserPushTransition(async () => {
      if (!current()) return;
      const settings = await workspaceRequest<PushSettings>(`/api/notifications/push?deviceId=${encodeURIComponent(device.current)}`, { signal });
      if (!current()) return;
      if (settings.accountId !== accountId) throw new Error("登录账号已变化，请刷新页面。");
      if (!settings.available || !settings.publicKey) { setDiagnostic("服务器尚未启用后台推送，当前仅在页面打开时提醒。"); return; }
      const previous = localStorage.getItem(PUSH_OWNER_KEY); if (previous && previous !== accountId) await clearBrowserPush();
      const registration = await pushRegistration(true); if (!registration) throw new Error("浏览器不支持后台推送。");
      let subscription = await registration.pushManager.getSubscription();
      if (!current()) return;
      if (!settings.subscription && subscription) { await subscription.unsubscribe(); subscription = null; }
      subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(settings.publicKey).buffer as ArrayBuffer });
      const saved = await pushRequest<PushSettings>({ action: "subscribe", deviceId: device.current, subscription: subscription.toJSON() });
      if (!current()) { await clearBrowserPush(); await pushRequest({ action: "revoke", deviceId: device.current }); return; }
      await bindBrowserPush(saved, accountId);
      if (!current()) { await clearBrowserPush(); await pushRequest({ action: "revoke", deviceId: device.current }); return; }
      pushRef.current = true; setBackground(true); setPushAvailable(true); setDiagnostic("后台推送已开启。可发送测试提醒确认此浏览器的显示结果。");
      });
    } catch (failure) { if (current()) setDiagnostic(failure instanceof Error ? failure.message : "后台推送暂时无法开启，页面打开时的提醒仍然可用。"); }
  }, [accountId, pushRequest]);
  const toggleSystem = useCallback(async () => {
    if (enabled) { await disableSystem(); return; }
    if (!("Notification" in window) || !window.isSecureContext) { setPermission("unsupported"); return; }
    try {
      // Permission is requested only in this explicit button handler.
      const nextPermission = enabled ? Notification.permission : await Notification.requestPermission(); setPermission(nextPermission);
      const next = !enabled && nextPermission === "granted";
      const existing = JSON.parse(localStorage.getItem(storageKey) || "{}");
      device.current = typeof existing.deviceId === "string" && /^[a-f0-9-]{36}$/i.test(existing.deviceId) ? existing.deviceId : crypto.randomUUID();
      localStorage.setItem(storageKey, JSON.stringify({ deviceId: device.current, enabled: next }));
      enabledRef.current = next; setEnabled(next);
      if (next) await enableBackground();
    } catch { setError("无法开启此设备的系统提醒，站内提醒仍然可用。"); }
  }, [disableSystem, enableBackground, enabled, storageKey]);
  const testSystem = useCallback(async () => {
    if (!enabledRef.current || Notification.permission !== "granted") { setDiagnostic("请先开启此设备的系统提醒。"); return; }
    try {
      if (pushRef.current) { await pushRequest({ action: "test", deviceId: device.current }); setDiagnostic("测试推送已排队。可关闭此页面或切换应用，稍后回来查看浏览器回执。"); lastPushRefresh.current = Date.now(); }
      else { const notice = new Notification("Agent Comm 测试提醒", { body: "这是此设备的显示测试，不会执行协作或批准授权。", tag: `agent-comm-test:${accountId}` }); notice.onclick = () => { window.focus(); window.location.assign("/dashboard/notifications"); notice.close(); }; setDiagnostic("已向浏览器提交显示请求；是否出现横幅由浏览器和系统通知设置决定。"); }
    } catch (failure) { setDiagnostic(failure instanceof Error ? failure.message : "测试提醒未能提交，请检查浏览器通知权限。"); }
  }, [accountId, pushRequest]);
  return <NotificationContext.Provider value={{ page, error, refresh, markRead, enabled, permission, toggleSystem, enableBackground, disableSystem, background, pushAvailable, away, diagnostic, testSystem }}>{children}</NotificationContext.Provider>;
}
export function useNotifications() { const context = useContext(NotificationContext); if (!context) throw new Error("NotificationProvider is required"); return context; }
