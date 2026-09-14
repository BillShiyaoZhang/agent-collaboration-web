export { SYNC_INTERVAL_MS, CAPABILITY_INTERVAL_MS, SYNC_LEASE_MS, AUTOMATIC_METHODS, syncReadPlan, syncBackoff, nextCycleDelay } from "@agent-comm/client-contract";
import { record, string, isPairingError } from "@agent-comm/client-contract";

export function syncError(response: Record<string, unknown>): { pairing: boolean; message: string } | null {
  if (!response.error) return null;
  const code = string(record(response.error).code);
  const pairing = isPairingError(code);
  return { pairing, message: pairing ? "需要在 agent 本机完成或续期配对，上次同步的内容仍已保存。" : "部分信息暂时无法同步，正在保留上次成功的内容。" };
}
