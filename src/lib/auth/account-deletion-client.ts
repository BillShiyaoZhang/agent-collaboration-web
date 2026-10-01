export type DeletionResult = { state: "deleted" | "rejected" | "uncertain"; message: string; consoleUrn?: string };
const UNKNOWN = "尚不能确认账户是否已删除。请先核实账户状态，不要重复提交删除请求。";

/** Current browser/account only; a shared origin can hold other accounts' reports. */
export function clearDeletedAccountLocalRecords(accountId:string,storage:Pick<Storage,"length"|"key"|"removeItem">=localStorage) {
  const prefix=`content-report:v1:${encodeURIComponent(accountId)}:`,keys=Array.from({length:storage.length},(_,index)=>storage.key(index));
  for(const key of keys)if(key && (key.startsWith(prefix) || key===`agent-notifications:v1:${accountId}`))storage.removeItem(key);
}

/** Only the explicit success receipt proves deletion; a lost reply can follow a commit. */
export async function requestAccountDeletion(currentPassword: string, expectedAccountId: string, send: typeof fetch = fetch): Promise<DeletionResult> {
  try {
    const response = await send("/api/auth/delete-account", {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      body: JSON.stringify({ currentPassword, expectedAccountId, confirmation: "DELETE" }), signal: AbortSignal.timeout(30000),
    });
    const body: unknown = await response.json().catch(() => null);
    const data = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    if (response.status === 200 && data.deleted === true) return { state: "deleted", message: "账户已删除，本工作区的登录会话已失效。", ...(typeof data.consoleUrn === "string" ? { consoleUrn: data.consoleUrn } : {}) };
    const rejected = [400, 401, 403, 409, 413].includes(response.status) || data.code === "DELETE_SCHEMA_UNSUPPORTED" || data.code === "WORKSPACE_REVOKE_UNCONFIRMED";
    if (!rejected) return { state: "uncertain", message: UNKNOWN };
    const fallback = response.status === 401 ? "登录已失效，请重新登录以确认账户状态。"
      : response.status === 413 ? "请求内容过大，删除未执行。" : "请求被拒绝，账户未删除。请核对输入和登录状态。";
    return { state: "rejected", message: typeof data.error === "string" ? data.error : fallback };
  } catch {
    return { state: "uncertain", message: UNKNOWN };
  }
}
