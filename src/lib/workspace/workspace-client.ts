export { mergeSnapshots, mergeTurns, pairingAllowsSend } from "@agent-comm/client-contract";
import type { WorkspaceSync } from "@agent-comm/client-contract";

export function syncLabel(sync: WorkspaceSync, hasSaved = false): string {
  if (sync.status === "needs_pairing") return hasSaved ? "需要重新配对 · 显示已保存内容" : "等待本机配对";
  if (sync.status === "offline") return hasSaved ? "暂未连上 · 显示已保存内容" : "暂未收到 agent 响应";
  if (sync.status === "syncing") return hasSaved ? "正在后台同步" : "正在首次同步";
  if (sync.status === "ready") return "已同步";
  return hasSaved ? "已保存 · 等待同步" : "等待同步";
}
