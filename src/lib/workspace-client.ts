import { record, string, type RemoteRecord } from "./workbench-client";
import type { WorkspaceSnapshot, WorkspaceSync } from "./workspace-types";

export function mergeSnapshots<T extends Partial<Record<string, WorkspaceSnapshot>>>(previous: T, incoming: T): T {
  const merged = { ...previous };
  for (const [method, snapshot] of Object.entries(incoming)) {
    if (snapshot && (!merged[method] || snapshot.time >= merged[method]!.time)) (merged as Record<string, WorkspaceSnapshot>)[method] = snapshot;
  }
  return merged;
}

export function mergeTurns(earlier: RemoteRecord[], latest: RemoteRecord[]): RemoteRecord[] {
  const byId = new Map(earlier.map(turn => [string(turn.turn_id), turn]));
  for (const turn of latest) {
    const id = string(turn.turn_id), saved = byId.get(id);
    // A delayed cache read cannot make a completed turn look pending again.
    const terminal = saved && (["completed", "failed"].includes(string(saved.status)) || saved.status === "interrupted" && saved.locally_unconfirmed !== true);
    if (terminal && ["submitted", "running"].includes(string(turn.status))) continue;
    byId.set(id, turn);
  }
  return Array.from(byId.values()).sort((a, b) => Number(a.created_at || 0) - Number(b.created_at || 0) || string(a.turn_id).localeCompare(string(b.turn_id)));
}

export function syncLabel(sync: WorkspaceSync, hasSaved = false): string {
  if (sync.status === "needs_pairing") return hasSaved ? "需要重新配对 · 显示已保存内容" : "等待本机配对";
  if (sync.status === "offline") return hasSaved ? "暂未连上 · 显示已保存内容" : "暂未收到 agent 响应";
  if (sync.status === "syncing") return hasSaved ? "正在后台同步" : "正在首次同步";
  if (sync.status === "ready") return "已同步";
  return hasSaved ? "已保存 · 等待同步" : "等待同步";
}

export function pairingAllowsSend(capabilities: RemoteRecord | undefined, sync: WorkspaceSync, now = Date.now()): boolean {
  if (sync.status === "needs_pairing") return false;
  const expiry = record(capabilities?.pairing).expires_at;
  if (expiry === undefined || expiry === null) return true;
  const expiresAt = typeof expiry === "number" ? expiry * 1000 : typeof expiry === "string" ? Date.parse(expiry) : NaN;
  return Number.isFinite(expiresAt) && expiresAt > now;
}
