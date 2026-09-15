// Compatibility entry point: reusable behavior lives in the standalone client package.
export { WorkbenchClient, WorkbenchError, record, records, string, strings, pause, conversationPending, conversationSettled } from "@agent-comm/client-contract";
export type { RpcMethod, RemoteRecord, PendingCall } from "@agent-comm/client-contract";
import { string } from "@agent-comm/client-contract";

export function displayTime(value: unknown): string {
  const date = typeof value === "number" ? new Date(value * 1000) : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "";
}

export function stateLabel(value: unknown): string {
  const status = string(value);
  return ({ submitted: "等待处理", running: "处理中", completed: "本回合已完成", failed: "处理失败", interrupted: "结果待核实", pending: "待确认", presenting: "等待本机确认", expired: "已过期", active: "已授权", revoked: "已撤销", ready: "准备发送", sending: "正在投递", accepted: "本机队列已接收", awaiting_approval: "待确认", denied: "已拒绝", approved: "已确认" } as Record<string, string>)[status] || status || "未提供状态";
}
