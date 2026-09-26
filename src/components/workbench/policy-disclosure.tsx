"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { useHydrated } from "@/components/local-time";
import type { PolicyDisclosure } from "@/lib/control/policy-disclosure-types";

async function readResponse(response: Response): Promise<PolicyDisclosure> {
  const body = await response.json() as PolicyDisclosure & { error?: string };
  if (!response.ok) throw new Error(body.error || "无法读取平台政策。");
  if (body.status !== "legacy" && body.status !== "signed") throw new Error("平台政策状态无效。");
  return body;
}

const PolicyAccessContext = createContext(false);
export function usePolicyAccess() {
  const access = useContext(PolicyAccessContext);
  const hydrated = useHydrated();
  // A layout provider may refresh before a streamed page consumer hydrates.
  // Reproduce that consumer's server snapshot, then use the current policy.
  return hydrated && access;
}

/** Disclose the verified policy while retaining access to saved, read-only account history. */
export function PolicyDisclosureGate({ children, compact = false }: { children: ReactNode; compact?: boolean }) {
  const [policy, setPolicy] = useState<PolicyDisclosure | null>(null);
  const [error, setError] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const requestNumber = useRef(0);
  const displayedHash = useRef("");
  const changingAccess = useRef(false);
  const refresh = useCallback(async () => {
    if (changingAccess.current) return;
    const request = ++requestNumber.current;
    try {
      const current = await readResponse(await fetch("/api/platform-policy", { cache: "no-store" }));
      if (request !== requestNumber.current) return;
      setPolicy(current); setError("");
      const hash = current.status === "signed" ? current.policy_hash : "";
      if (hash !== displayedHash.current) setAccepted(false);
      displayedHash.current = hash;
    } catch (cause) {
      if (request !== requestNumber.current) return;
      setPolicy(null);
      setError(cause instanceof Error ? cause.message : "无法验证平台政策。");
    }
  }, []);
  useEffect(() => {
    const sequence = requestNumber;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 30000);
    const visible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", visible);
    return () => { sequence.current++; window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);

  const confirm = async () => {
    if (policy?.status !== "signed" || policy.mode !== "compliance" || !accepted || submitting) return;
    setSubmitting(true);
    changingAccess.current = true;
    requestNumber.current++; // An earlier GET must not undo a successful confirmation.
    try {
      const current = await readResponse(await fetch("/api/platform-policy", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy_hash: policy.policy_hash, confirm: true }),
      }));
      setPolicy(current); setError(""); setAccepted(false);
    } catch (cause) {
      setPolicy(null);
      setError(cause instanceof Error ? cause.message : "确认失败，请重新读取当前政策。");
    } finally { changingAccess.current = false; setSubmitting(false); }
  };

  const pause = async () => {
    if (!policy || policy.paused || submitting) return;
    setSubmitting(true); changingAccess.current = true; requestNumber.current++;
    try {
      const response = await fetch("/api/platform-policy", { method: "DELETE", cache: "no-store" });
      const body = await response.json() as { paused?: boolean; error?: string };
      if (!response.ok || body.paused !== true) throw new Error(body.error || "暂停状态未保存，请重试。");
      setPolicy({ ...policy, paused: true, can_use_workbench: false }); setError("");
    } catch (cause) {
      setPolicy(null); setError(cause instanceof Error ? cause.message : "暂停状态未确认，请重试。");
    } finally { changingAccess.current = false; setSubmitting(false); }
  };

  const resume = async () => {
    if (!policy?.paused || submitting) return;
    setSubmitting(true); changingAccess.current = true; requestNumber.current++;
    try {
      const current = await readResponse(await fetch("/api/platform-policy", {
        method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resume: true }),
      }));
      setPolicy(current); setError(""); setDetailsOpen(false);
    } catch (cause) {
      setPolicy(null); setError(cause instanceof Error ? cause.message : "无法恢复使用，请重新核验政策。");
    } finally { changingAccess.current = false; setSubmitting(false); }
  };

  if (!policy) return <PolicyAccessContext.Provider value={false}><section role="status" className={compact ? "max-h-[min(35dvh,max(4rem,calc(100dvh-28rem)))] shrink-0 overflow-y-auto border-b border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950" : "break-words rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950"}>
    <h2 className="font-semibold">正在核验平台政策</h2>
    <p className="mt-2 leading-6">{error || "核验完成前，新的远程控制与后台同步暂不连接 agent。已保存内容仍可查看。"}</p>
    {error && <Button variant="outline" size="sm" className="mt-3" onClick={() => void refresh()}>重新核验</Button>}
  </section>{children}</PolicyAccessContext.Provider>;

  const showDetails = !policy.can_use_workbench || detailsOpen;
  return <PolicyAccessContext.Provider value={policy.can_use_workbench}>
    <section aria-label="平台政策与内容可见范围" className={`${compact ? "max-h-[min(35dvh,max(4rem,calc(100dvh-28rem)))] shrink-0 overflow-y-auto border-b px-3 py-1.5" : "break-words rounded-2xl border p-4"} text-sm ${policy.can_use_workbench ? "border-border bg-card text-foreground" : "border-amber-300 bg-amber-50 text-amber-950"}`}>
      <div className={compact ? "flex flex-wrap items-center justify-between gap-2" : "flex flex-wrap items-start justify-between gap-2"}>
        <div className={compact && policy.can_use_workbench ? "flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-0.5" : "min-w-0 flex-1"}>
          <h2 className={compact ? "text-xs font-medium" : "font-semibold"}>{policy.can_use_workbench ? "平台政策与内容可见范围" : policy.paused ? "远程控制与同步已暂停" : "请确认平台政策"}</h2>
          <p className={compact ? "text-xs leading-5 text-muted-foreground" : "mt-1 text-xs leading-5"}>{policy.status === "legacy"
            ? "尚无可验证的 v2 签名政策；网页可读取已授权的工作台内容。"
            : policy.mode === "compliance"
              ? "平台网关可解密符合政策的 agent 间 v2 消息；网页可读取已授权的工作台内容。"
              : "平台网关不获 v2 私密消息内容密钥；网页可读取已授权的工作台内容。"}</p>
        </div>
        {policy.can_use_workbench && <Button type="button" variant="ghost" size="sm" className={compact ? "h-7 max-w-full shrink-0 px-2 text-xs" : "h-auto w-full max-w-full min-w-0 justify-start whitespace-normal py-2 text-left sm:w-auto"} aria-expanded={detailsOpen} aria-controls="policy-details" onClick={() => setDetailsOpen(open => !open)}>{detailsOpen ? "收起详情" : "查看详情与控制"}</Button>}
      </div>
      {showDetails && <div id="policy-details" className="mt-3 border-t pt-3">
      {policy.status === "legacy" ? <p className="leading-6">平台尚未提供可验证的 v2 签名政策；此处不能证明 agent 之间使用了隐私或合规模式。工作台沿用托管控制通道，网页服务可读取 agent 授权同步给本账户的内容。</p> : <>
        <p className="mt-2 leading-6">已验证平台签名政策：<strong>{policy.mode === "compliance" ? "合规模式" : "隐私模式"}</strong> · epoch {policy.epoch} · 平台 {policy.platform_id}。</p>
        <p className="mt-2 leading-6">{policy.mode === "compliance"
          ? `按此政策，符合 v2 的 agent 间消息必须允许平台网关解密；网关密钥 ID：${policy.gateway_key_id}。`
          : "按此政策，符合 v2 的 agent 间私密消息不向平台网关提供内容密钥。"}本页显示的是政策，不证明某一条 agent 消息的实际发送模式。</p>
        <p className="mt-2 leading-6">本工作台的远程控制仍使用已配对的托管 v1 通道；网页服务可以解密 agent 授权的控制回复和同步副本。这与平台网关能否解密 agent 间 v2 消息是两种不同的可见范围。</p>
        {policy.mode === "compliance" && !policy.confirmed && <div className="mt-4 rounded-xl border border-amber-400 bg-white p-4">
          <p className="font-medium">继续使用前，请确认当前合规披露</p>
          <p className="mt-1 leading-6">确认后才能继续远程控制和后台同步。已有控制台身份、agent 配对和已保存数据会保留；政策变化时需要重新确认。</p>
          <label className="mt-3 flex items-start gap-2 leading-6"><input type="checkbox" className="mt-1" checked={accepted} onChange={event => setAccepted(event.target.checked)} />
            <span>我已了解：平台网关可解密符合此合规政策的 agent 间 v2 消息；网页服务可读取本工作台经授权的控制内容。</span></label>
          <Button className="mt-3 h-auto max-w-full whitespace-normal py-2 text-center" disabled={!accepted || submitting} onClick={() => void confirm()}>{submitting ? "正在确认…" : "确认并继续使用"}</Button>
        </div>}
        {policy.mode === "compliance" && policy.confirmed && !policy.paused && <p className="mt-2 font-medium">本账户已确认当前政策，可继续使用工作台。</p>}
      </>}
      {policy.paused && <p className="mt-3 rounded-xl border border-amber-400 bg-white p-3 leading-6">本账户已暂停新的远程控制和后台同步。已保存内容仍可查看；已经披露的内容无法收回。若要停止 Agent 向合规网关披露，请按已安装版本的说明在 Agent 本机运行 v2-disallow-compliance；若要撤销 Web 访问，请在 Agent 本机撤销控制台配对。两者互不替代。</p>}
      <div className="mt-3">{policy.can_use_workbench
        ? <Button variant="outline" size="sm" className="h-auto max-w-full whitespace-normal py-2 text-center" disabled={submitting} onClick={() => void pause()}>暂停后续远程控制与同步</Button>
        : !policy.paused
          ? <Button variant="outline" size="sm" className="h-auto max-w-full whitespace-normal py-2 text-center" disabled={submitting} onClick={() => void pause()}>暂不接受并暂停后续控制与同步</Button>
        : policy.paused && (policy.status === "legacy" || policy.mode === "private" || policy.confirmed)
          ? <Button variant="outline" size="sm" className="h-auto max-w-full whitespace-normal py-2 text-center" disabled={submitting} onClick={() => void resume()}>恢复远程控制与同步</Button>
          : null}</div>
      </div>}
    </section>
    {children}
  </PolicyAccessContext.Provider>;
}
