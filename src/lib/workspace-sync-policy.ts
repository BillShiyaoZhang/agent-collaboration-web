import { record, records, string } from "./workbench-client";
import type { WorkspaceAgent } from "./workspace-types";
import type { SyncPlanItem } from "./workspace-store";

export const SYNC_INTERVAL_MS = 30_000;
export const CAPABILITY_INTERVAL_MS = 120_000;
export const SYNC_LEASE_MS = 60_000;
export const AUTOMATIC_METHODS = new Set(["capabilities", "contacts.list", "collaboration.state", "inbox.list", "conversation.get"]);

/** Fixed read-only allowlist: advertised methods can never schedule a write. */
export function syncReadPlan(workspace: WorkspaceAgent, conversationIds: string[], now: number): SyncPlanItem[] {
  const capability = workspace.snapshots.capabilities;
  const expiry = record(capability?.data.pairing).expires_at;
  const expiresAt = typeof expiry === "number" ? (expiry < 1e12 ? expiry * 1000 : expiry) : typeof expiry === "string" ? Date.parse(expiry) : NaN;
  if (!capability || now - capability.time >= CAPABILITY_INTERVAL_MS || (Number.isFinite(expiresAt) && expiresAt <= now) || ["offline", "needs_pairing"].includes(workspace.sync.status)) {
    return [{ method: "capabilities", params: {} }];
  }
  const allowed = new Set(records(capability.data.methods).filter(item => item.available === true).map(item => string(item.name)));
  const plan: SyncPlanItem[] = [];
  const stale = (method: "collaboration.state" | "contacts.list" | "inbox.list") => now - (workspace.snapshots[method]?.time || 0) >= SYNC_INTERVAL_MS;
  if (allowed.has("collaboration.state")) {
    if (stale("collaboration.state")) plan.push({ method: "collaboration.state", params: {} });
  } else {
    if (allowed.has("contacts.list") && stale("contacts.list")) plan.push({ method: "contacts.list", params: {} });
    if (allowed.has("inbox.list") && stale("inbox.list")) plan.push({ method: "inbox.list", params: {} });
  }
  if (allowed.has("conversation.get")) {
    for (const id of Array.from(new Set(conversationIds)).slice(0, 5)) {
      if (/^[A-Za-z0-9._:-]{1,128}$/.test(id)) plan.push({ method: "conversation.get", params: { conversation_id: id } });
    }
  }
  return plan;
}

export function syncBackoff(failures: number): number {
  return Math.min(300_000, 30_000 * 2 ** Math.min(Math.max(failures - 1, 0), 4));
}

export function syncError(response: Record<string, unknown>): { pairing: boolean; message: string } | null {
  if (!response.error) return null;
  const code = string(record(response.error).code);
  const pairing = ["not_paired", "owner_mismatch", "pairing_expired", "pairing_revoked"].includes(code);
  return { pairing, message: pairing ? "需要在 agent 本机完成或续期配对，上次同步的内容仍已保存。" : "部分信息暂时无法同步，正在保留上次成功的内容。" };
}

export function nextCycleDelay(workspace: WorkspaceAgent): number {
  return workspace.submission || workspace.conversations.some(item => item.pending) ? 5_000 : SYNC_INTERVAL_MS;
}
