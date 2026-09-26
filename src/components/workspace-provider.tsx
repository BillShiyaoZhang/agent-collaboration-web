"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceAgent, WorkspaceConnection, WorkspaceOverview } from "@/lib/workspace/workspace-types";

type Draft = { text: string; tab: string; dirty: boolean; revision: number };
type WorkspaceContextValue = {
  connections: WorkspaceConnection[]; loading: boolean; error: string;
  refresh: () => Promise<void>; requestSync: (agentId?: string) => Promise<void>;
  getCachedAgent: (id: string) => WorkspaceAgent | undefined;
  cacheAgent: (data: WorkspaceAgent) => void;
  getDraft: (id: string) => Draft | undefined;
  saveDraft: (id: string, value: Partial<Draft>) => void;
};
const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export async function workspaceRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController(), cancel = () => controller.abort();
  if (init.signal?.aborted) controller.abort();
  init.signal?.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 20000);
  try {
    const response = await fetch(url, { cache: "no-store", ...init, signal: controller.signal });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(response.status === 401 ? "登录已过期，请重新登录。" : data?.error || "暂时无法连接服务器，已保存的内容仍可查看。");
    if (data === null) throw new Error("暂时无法读取服务器内容，已保存的数据仍可查看。");
    return data as T;
  } catch (failure) {
    if (controller.signal.aborted && !init.signal?.aborted) throw new Error("连接暂时没有响应，显示已保存的内容。稍后会自动重试。");
    if (failure instanceof TypeError) throw new Error("网络暂时中断，显示已保存的内容。恢复连接后会自动更新。");
    throw failure;
  } finally { clearTimeout(timer); init.signal?.removeEventListener("abort", cancel); }
}

export function WorkspaceProvider({ initial, children }: { initial: WorkspaceOverview; children: React.ReactNode }) {
  const [connections, setConnections] = useState(initial.connections);
  // The authenticated layout supplies the first result; revalidation never replaces it with a skeleton.
  const loading = false;
  const [error, setError] = useState("");
  const cache = useRef(new Map<string, WorkspaceAgent>());
  const drafts = useRef(new Map<string, Draft>());
  const lifecycle = useRef<AbortController | null>(null);
  const reading = useRef(false);
  const syncCalls = useRef(new Set<string>());
  const refresh = useCallback(async () => {
    const signal = lifecycle.current?.signal;
    if (!signal || signal.aborted || reading.current) return;
    reading.current = true;
    try {
      const data = await workspaceRequest<WorkspaceOverview>("/api/workspace", { signal });
      if (!signal.aborted) { setConnections(data.connections); setError(""); }
    } catch (failure) {
      if (!signal.aborted) setError(failure instanceof Error ? failure.message : "网络暂时中断，显示已保存的连接。");
    } finally { reading.current = false; }
  }, []);
  const requestSync = useCallback(async (agentId?: string) => {
    const key = agentId || "all", signal = lifecycle.current?.signal;
    if (!signal || signal.aborted || syncCalls.current.has(key)) return;
    syncCalls.current.add(key);
    try {
      await workspaceRequest("/api/workspace/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(agentId ? { agentId } : {}), signal });
      if (!signal.aborted) { setError(""); await refresh(); }
    } catch (failure) {
      if (!signal.aborted) setError(failure instanceof Error ? failure.message : "暂时无法安排同步，稍后会自动重试。");
    } finally { syncCalls.current.delete(key); }
  }, [refresh]);
  useEffect(() => {
    const controller = new AbortController(); lifecycle.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    let generation = 0;
    const run = async () => {
      const current = ++generation; clearTimeout(timer);
      await refresh();
      if (!controller.signal.aborted && current === generation) timer = setTimeout(run, document.hidden ? 30000 : 5000);
    };
    // Begin synchronization for every connection before any card or tab is opened.
    void requestSync(); void run();
    const resume = () => { void run(); };
    const online = () => { void requestSync(); resume(); };
    const offline = () => setError("网络已断开，显示已保存的内容。恢复连接后会自动继续同步。");
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", online); window.addEventListener("offline", offline);
    return () => { generation++; controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", resume); window.removeEventListener("online", online); window.removeEventListener("offline", offline); };
  }, [refresh, requestSync]);
  const getCachedAgent = useCallback((id: string) => cache.current.get(id), []);
  const cacheAgent = useCallback((data: WorkspaceAgent) => { cache.current.set(data.agent.id, data); }, []);
  const getDraft = useCallback((id: string) => drafts.current.get(id), []);
  const saveDraft = useCallback((id: string, value: Partial<Draft>) => { drafts.current.set(id, { text: "", tab: "conversation", dirty: false, revision: 0, ...drafts.current.get(id), ...value }); }, []);
  const value = useMemo(() => ({ connections, loading, error, refresh, requestSync, getCachedAgent, cacheAgent, getDraft, saveDraft }), [connections, loading, error, refresh, requestSync, getCachedAgent, cacheAgent, getDraft, saveDraft]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("WorkspaceProvider is required");
  return workspace;
}
