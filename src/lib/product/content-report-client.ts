export type ReportTarget = { kind: "contact" | "contact_request" | "inbox" | "turn" | "collaboration"; id: string };
export type ReportSession = { accountId: string; loginSessionId: string; sessionVersion: number };
export type ReportScope = ReportSession & { origin: string; agentId: string; target: ReportTarget };
export type ReportRequest = { reportId: string; agentId: string; target: ReportTarget; reason: string; comment: string; evidence: string; previewToken: string; consent: true };
export type ReportReceipt = { id: string; agentId: string; target: ReportTarget; reason: string; status: string; response?: string };
export const reportRecoveryPrefix = (accountId: string) => "content-report:v1:" + encodeURIComponent(accountId) + ":";
const byteLength = (text: string) => new TextEncoder().encode(text).length;
const uuid = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const reasonValues = ["harassment", "hate", "sexual", "violence", "spam", "other"];
const targetValues = ["contact", "contact_request", "inbox", "turn", "collaboration"];
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function validTarget(value: unknown): value is ReportTarget { return record(value) && typeof value.kind === "string" && targetValues.includes(value.kind) && typeof value.id === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.id); }
export function validReportRequest(value: unknown): value is ReportRequest {
  return record(value) && uuid(value.reportId) && typeof value.agentId === "string" && value.agentId.length > 0 && value.agentId.length <= 128
    && validTarget(value.target) && typeof value.reason === "string" && reasonValues.includes(value.reason) && value.consent === true
    && typeof value.comment === "string" && byteLength(value.comment) <= 2000 && typeof value.evidence === "string" && byteLength(value.evidence) <= 4000
    && typeof value.previewToken === "string" && value.previewToken.length > 0 && value.previewToken.length <= 4096;
}
export function validReportReceipt(value: unknown, id: string, expected?: ReportRequest): value is ReportReceipt {
  return record(value) && uuid(value.id) && value.id === id && typeof value.agentId === "string" && value.agentId.length > 0 && validTarget(value.target) && typeof value.reason === "string" && reasonValues.includes(value.reason)
    && typeof value.status === "string" && ["pending", "reviewing", "resolved", "dismissed"].includes(value.status)
    && (!expected || value.agentId === expected.agentId && value.reason === expected.reason && value.target.kind === expected.target.kind && value.target.id === expected.target.id);
}

/** Login identity is verified before dispatch and after each reply. A disposed
 * view never revives after a delayed account/session verification. */
export function createReportScopeGuard(scope: ReportScope, read: () => Promise<ReportSession | null>, origin: () => string) {
  let active = true;
  return { dispose() { active = false; }, async current() {
    if (!active) return false;
    let session: ReportSession | null;
    try { session = await read(); } catch { return false; }
    const matches = origin() === scope.origin && !!session && session.accountId === scope.accountId
      && session.loginSessionId === scope.loginSessionId && session.sessionVersion === scope.sessionVersion;
    if (!matches) active = false;
    return active && matches;
  } };
}

/** Exact unknown requests survive refresh and close. This is ordinary site
 * storage, not encrypted storage. It is isolated by origin, account and target. */
export function createReportJournal(storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, scope: Pick<ReportScope, "accountId" | "agentId" | "target">) {
  const key = reportRecoveryPrefix(scope.accountId) + encodeURIComponent(JSON.stringify([scope.agentId, scope.target.kind, scope.target.id]));
  return { read(): ReportRequest | null {
    const raw = storage.getItem(key); if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (!validReportRequest(value) || value.agentId !== scope.agentId || value.target.kind !== scope.target.kind || value.target.id !== scope.target.id) throw new Error("无法核对原举报恢复记录，本次未提交。");
    return value;
  }, save(body: ReportRequest) {
    if (!validReportRequest(body) || body.agentId !== scope.agentId || body.target.kind !== scope.target.kind || body.target.id !== scope.target.id) throw new Error("举报与当前记录不一致，本次未提交。");
    const raw = JSON.stringify(body), existing = storage.getItem(key);
    if (existing !== null && existing !== raw) throw new Error("此记录已有另一份原举报，请重新打开并核实它，不能覆盖。");
    storage.setItem(key, raw);
    if (storage.getItem(key) !== raw) throw new Error("无法保存原举报，本次未提交。");
  }, clear(expected: ReportRequest) {
    const existing = storage.getItem(key);
    if (existing === null) return;
    if (existing !== JSON.stringify(expected)) throw new Error("本机恢复记录已变化，请核实当前原举报，不能清理另一份请求。");
    storage.removeItem(key); if (storage.getItem(key) !== null) throw new Error("原举报本机清理尚未完成。");
  } };
}

/** Cross-tab exclusion must cover the journal read/write and HTTP result. A
 * browser without Web Locks cannot safely submit a new report from this view. */
export async function withReportTargetLock<T>(scope: Pick<ReportScope, "accountId" | "agentId" | "target">, locks: Pick<LockManager, "request"> | undefined, operation: () => Promise<T>): Promise<T> {
  if (!locks) throw new Error("此浏览器暂时无法提交举报，本次未提交。可改用原生客户端。");
  return locks.request(reportRecoveryPrefix(scope.accountId) + JSON.stringify([scope.agentId, scope.target.kind, scope.target.id]), { mode: "exclusive", ifAvailable: true }, async lock => {
    if (!lock) throw new Error("此记录的举报正在另一页面处理，请稍后核实原记录。");
    return operation();
  });
}

export async function submitReportOnce(body: ReportRequest, send: typeof fetch = fetch) {
  if (!validReportRequest(body)) throw new Error("举报内容不完整或过长，本次未提交。");
  try {
    const response = await send("/api/moderation/reports", { method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store", body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const value: unknown = await response.json().catch(() => null);
    if (response.status === 200 && record(value) && validReportReceipt(value.report, body.reportId, body)) return { state: "accepted" as const, report: value.report, message: "举报已保存，可在“我的举报”查看处理状态与回复。" };
    if ([400, 401, 403, 404, 409, 413, 429].includes(response.status)) return { state: "rejected" as const, message: record(value) && typeof value.error === "string" ? value.error : "提交被拒绝，请核对当前账户和内容。" };
  } catch { /* A lost response can follow a committed report. Never resend here. */ }
  return { state: "uncertain" as const, message: "回执尚未核实。请保留原编号，核实或明确重试同一举报。" };
}
