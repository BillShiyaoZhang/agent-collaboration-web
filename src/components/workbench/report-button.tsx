"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { getSession } from "next-auth/react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useWorkspace } from "@/components/workspace-provider";
import { createReportJournal, createReportScopeGuard, submitReportOnce, validReportReceipt, withReportTargetLock, type ReportRequest, type ReportScope, type ReportSession, type ReportTarget } from "@/lib/product/content-report-client";

const reasons = { harassment: "骚扰或欺凌", hate: "仇恨或歧视", sexual: "不适宜的性内容", violence: "威胁或暴力", spam: "垃圾内容或诈骗", other: "其他问题" };
async function readSession(): Promise<ReportSession | null> {
  const user = (await getSession({ broadcast: false }))?.user;
  return user?.id && user.loginSessionId ? { accountId: user.id, loginSessionId: user.loginSessionId, sessionVersion: user.sessionVersion ?? 0 } : null;
}
export function ReportButton({ agentId, target }: { agentId: string; target: ReportTarget }) {
  const { accountId, sessionVersion } = useWorkspace();
  return <ReportForm key={JSON.stringify([accountId, sessionVersion, agentId, target.kind, target.id])} accountId={accountId} sessionVersion={sessionVersion} agentId={agentId} target={target} />;
}

function ReportForm({ accountId, sessionVersion, agentId, target }: { accountId: string; sessionVersion: number; agentId: string; target: ReportTarget }) {
  const [open, setOpen] = useState(false), [preview, setPreview] = useState<{ evidence: string; previewToken: string } | null>(null);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(""), [reason, setReason] = useState<keyof typeof reasons>("harassment"), [comment, setComment] = useState("");
  const [include, setInclude] = useState(false), [consent, setConsent] = useState(false), [unknown, setUnknown] = useState(false), [sent, setSent] = useState(false), [scopeValid, setScopeValid] = useState(true);
  const id = useRef(""), active = useRef(false), alive = useRef(true), saved = useRef<ReportRequest | null>(null);
  const scope = useRef<ReportScope | null>(null), guard = useRef<ReturnType<typeof createReportScopeGuard> | null>(null);
  const journal = useRef<ReturnType<typeof createReportJournal> | null>(null);
  const focusRevision = useRef(0), focused = useRef(true);
  const changed = useCallback(() => { if (!alive.current) return; setScopeValid(false); setPreview(null); setComment(""); setConsent(false); setInclude(false); setMessage("账户或登录会话已变化，请关闭并刷新后重新打开。"); }, []);
  const current = useCallback(async () => { const valid = !!guard.current && await guard.current.current(); if (!valid) changed(); return valid && alive.current; }, [changed]);
  async function currentView(revision: number) { return await current() && focused.current && revision === focusRevision.current; }
  useEffect(() => { alive.current = true; return () => { alive.current = false; guard.current?.dispose(); }; }, []);
  useEffect(() => {
    if (!open) return;
    const inspect = () => { void current(); }, hide = () => { focused.current = false; focusRevision.current++; setScopeValid(false); };
    const reveal = async () => { focused.current = true; const revision = ++focusRevision.current; if (await current() && focused.current && revision === focusRevision.current) setScopeValid(true); };
    const timer = setInterval(inspect, 4000);
    window.addEventListener("storage", inspect); window.addEventListener("blur", hide); window.addEventListener("focus", reveal);
    return () => { clearInterval(timer); window.removeEventListener("storage", inspect); window.removeEventListener("blur", hide); window.removeEventListener("focus", reveal); };
  }, [open, preview, unknown, sent, current]);

  async function prepare() {
    setOpen(true); if (preview || sent || unknown || active.current) return;
    active.current = true; setBusy(true); setMessage("");
    const viewRevision = focusRevision.current;
    try {
      const session = await readSession(); if (!alive.current) return;
      if (!session || session.accountId !== accountId || session.sessionVersion !== sessionVersion) { changed(); return; }
      if (scope.current && (session.loginSessionId !== scope.current.loginSessionId || !await current())) { changed(); return; }
      if (!scope.current) {
        scope.current = { ...session, origin: window.location.origin, agentId, target };
        guard.current = createReportScopeGuard(scope.current, readSession, () => window.location.origin);
        journal.current = createReportJournal(localStorage, scope.current);
      }
      const original = journal.current!.read(); if (!await currentView(viewRevision)) return;
      if (original) { id.current = original.reportId; saved.current = original; setUnknown(true); return; }
      id.current ||= crypto.randomUUID();
      const response = await fetch("/api/moderation/reports/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reportId: id.current, agentId, target }), cache: "no-store", signal: AbortSignal.timeout(20000) });
      const body = await response.json(); if (!await currentView(viewRevision)) return;
      if (response.status !== 200 || body.reportId !== id.current || typeof body.evidence !== "string" || new TextEncoder().encode(body.evidence).length > 4000 || typeof body.previewToken !== "string" || !body.previewToken || body.previewToken.length > 4096) throw new Error(body.error || "无法建立证据预览，请稍后再试。");
      setPreview(body); if (focused.current) setScopeValid(true);
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : "无法建立或恢复证据预览，本次未提交。"); }
    finally { active.current = false; if (alive.current) setBusy(false); }
  }
  async function submit(retry = false) {
    if (active.current || sent || (!retry && (!preview || !consent || unknown))) return;
    if (!retry && new TextEncoder().encode(comment).length > 2000) { setMessage("说明过长，请精简后提交。"); return; }
    active.current = true; setBusy(true); setMessage(""); const priorUnknown = unknown || retry;
    const viewRevision = focusRevision.current;
    try {
      if (!await currentView(viewRevision)) return;
      const body: ReportRequest | null = retry ? saved.current : preview ? { reportId: id.current, agentId, target, reason, comment, evidence: include ? preview.evidence : "", previewToken: preview.previewToken, consent: true } : null;
      if (!body || !journal.current) return;
      await withReportTargetLock(scope.current!, navigator.locks, async () => {
        if (!await currentView(viewRevision)) return;
        const existing = journal.current!.read();
        if (existing && JSON.stringify(existing) !== JSON.stringify(body)) { saved.current = existing; id.current = existing.reportId; setUnknown(true); setPreview(null); setConsent(false); setMessage("此记录已有原举报，请先核实原编号。"); return; }
        journal.current!.save(body); saved.current = body; if (!await currentView(viewRevision)) return;
        const result = await submitReportOnce(body); if (!await currentView(viewRevision)) return;
        setMessage(result.message);
        if (result.state === "accepted") { setSent(true); setUnknown(false); try { journal.current!.clear(body); } catch { setMessage(result.message + "本机恢复记录清理未完成，请在浏览器设置中清理本站数据。"); } }
        else if (result.state === "uncertain" || priorUnknown) setUnknown(true);
        else {
          setConsent(false); setPreview(null);
          try { journal.current!.clear(body); saved.current = null; }
          catch { setUnknown(true); setMessage("提交已被拒绝，但本机原记录清理未完成。请核实原记录或清理本站数据后继续。"); }
        }
      });
    } catch (error) { if (alive.current) setMessage(error instanceof Error ? error.message : "暂时无法保存原举报，本次未继续提交。"); }
    finally { active.current = false; if (alive.current) setBusy(false); }
  }
  async function check() {
    if (active.current) return; active.current = true; setBusy(true);
    const viewRevision = focusRevision.current;
    try {
      if (!await currentView(viewRevision) || !scope.current || !saved.current) return;
      const original = saved.current;
      await withReportTargetLock(scope.current, navigator.locks, async () => {
        if (!await currentView(viewRevision)) return;
        const existing = journal.current!.read();
        if (existing && JSON.stringify(existing) !== JSON.stringify(original)) { saved.current = existing; id.current = existing.reportId; setMessage("本机原举报已变化，请核实当前编号。"); return; }
        const response = await fetch("/api/moderation/reports/" + original.reportId, { cache: "no-store", signal: AbortSignal.timeout(20000) }), body = await response.json(); if (!await currentView(viewRevision)) return;
        if (response.status === 200 && validReportReceipt(body.report, original.reportId, original)) { setUnknown(false); setSent(true); setMessage("原举报已保存，状态与回复可在“我的举报”查看。"); try { journal.current!.clear(original); } catch { setMessage("原举报已保存，本机清理未完成，请在浏览器设置中清理本站数据。"); } }
        else setMessage("仍未确认原举报，请保留编号并稍后核实或联系公开支持邮箱。");
      });
    } catch { if (alive.current) setMessage("暂时无法核实原举报，请稍后查看；本次未重新提交。"); }
    finally { active.current = false; if (alive.current) setBusy(false); }
  }
  return <><Button type="button" size="sm" variant="ghost" className="min-h-11" onClick={() => void prepare()}>举报内容</Button><Dialog open={open} onOpenChange={value => { if (!busy || !scopeValid) setOpen(value); }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogTitle>举报这条记录</DialogTitle><DialogDescription>只提交本账户所属的这条记录及你选择的证据。不会默认附上整个聊天，也不会自动给他人发消息。</DialogDescription>{message && <p role="status" className="text-sm leading-6">{message}</p>}{scopeValid && <>{id.current && <p className="break-all text-xs text-muted-foreground">举报编号：{id.current}</p>}{unknown ? <div className="space-y-3"><p className="text-sm">原请求已保存在此浏览器的本站存储中。关闭或刷新后，从同一记录重新打开可继续核实。</p><Button type="button" className="min-h-11" variant="outline" disabled={busy} onClick={() => void check()}>核实原举报</Button>{saved.current && <Button type="button" className="min-h-11" variant="outline" disabled={busy} onClick={() => void submit(true)}>重试同一举报</Button>}</div> : sent ? <Link className="inline-flex min-h-11 items-center text-primary underline" href="/dashboard/reports">查看我的举报</Link> : preview ? <div className="space-y-4"><label className="block text-sm">原因<select className="mt-1 min-h-11 w-full rounded border bg-background p-2" value={reason} disabled={busy} onChange={event => { setReason(event.target.value as keyof typeof reasons); setConsent(false); }}>{Object.entries(reasons).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="block text-sm">补充说明（选填）<Textarea value={comment} disabled={busy} onChange={event => { setComment(event.target.value); setConsent(false); }} /></label>{preview.evidence ? <><pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-3 text-xs">{preview.evidence}</pre><label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy} checked={include} onChange={event => { setInclude(event.target.checked); setConsent(false); }} />附上这段已预览的证据</label></> : <p className="text-sm text-muted-foreground">此记录没有可附的已获准正文。举报仍可包含记录标识、原因和你的说明。</p>}<p className="text-xs text-muted-foreground">提交前，本浏览器会在本站存储中保存本次举报的原编号与内容以便核实；这是普通浏览器存储，清理本站数据会移除它。</p><label className="flex min-h-11 items-center gap-3 text-sm"><input type="checkbox" disabled={busy} checked={consent} onChange={event => setConsent(event.target.checked)} />我同意将上述原因、说明与勾选证据提交给本工作区处理人员。</label><Button type="button" className="min-h-11" disabled={busy || !consent} onClick={() => void submit()}>{busy ? "正在保存…" : "确认提交举报"}</Button></div> : <Button type="button" className="min-h-11" variant="outline" disabled={busy} onClick={() => void prepare()}>{busy ? "正在准备预览…" : "重新准备证据预览"}</Button>}</>}</DialogContent></Dialog></>;
}
