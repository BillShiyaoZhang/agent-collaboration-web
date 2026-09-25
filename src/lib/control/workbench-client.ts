// Compatibility entry point: reusable behavior lives in the standalone client package.
export { WorkbenchClient, WorkbenchError, record, records, string, strings, pause, conversationPending, conversationSettled } from "@agent-comm/client-contract";
export type { RpcMethod, RemoteRecord, PendingCall } from "@agent-comm/client-contract";
import { string } from "@agent-comm/client-contract";

export function stateLabel(value: unknown): string {
  const status = string(value);
  return ({ submitted: "等待处理", running: "处理中", completed: "本回合已完成", failed: "处理失败", interrupted: "结果待核实", pending: "待确认", presenting: "待确认", expired: "已过期", active: "已授权", revoked: "已撤销", ready: "准备发送", sending: "正在投递", accepted: "本机队列已接收", awaiting_approval: "待确认", denied: "已拒绝", approved: "已确认", approved_once: "已确认", confirmed: "已添加", already_confirmed: "已添加" } as Record<string, string>)[status] || status || "未提供状态";
}
