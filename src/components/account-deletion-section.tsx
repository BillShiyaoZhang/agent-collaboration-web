"use client";

import { useEffect, useRef, useState } from "react";
import { getSession, signOut } from "next-auth/react";
import type { Session } from "next-auth";
import Link from "next/link";
import { AuthNotice, PasswordInput } from "@/components/auth-shell";
import { useWorkspace } from "@/components/workspace-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { requestAccountDeletion, clearDeletedAccountLocalRecords, type DeletionResult } from "@/lib/auth/account-deletion-client";
import { browserPushTransition, clearBrowserPush, PUSH_OWNER_KEY } from "@/lib/notifications/browser-push";

export function AccountDeletionSection({ accountId, email, onDeleted }: { accountId: string; email: string; onDeleted: () => void }) {
  const [session, setSession] = useState<Session | null>(null);
  const { connections } = useWorkspace();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [dialog, setDialog] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DeletionResult | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkNotice, setCheckNotice] = useState("");
  const active = useRef(false);
  const pendingPassword = useRef("");
  const pendingIdentity = useRef<{ id: string; email: string } | null>(null);
  useEffect(() => {
    let mounted = true;
    getSession().then(value => { if (mounted) setSession(value); }).catch(() => { if (mounted) setSession(null); });
    return () => { mounted = false; };
  }, []);

  function prepare(event: React.FormEvent) {
    event.preventDefault();
    if (active.current || result?.state === "uncertain" || result?.state === "deleted") return;
    if (session?.user?.id !== accountId || session.user.email !== email) {
      setResult({ state: "rejected", message: "当前登录账户已改变或尚未确认，请刷新页面后再操作。" }); return;
    }
    if (!password || new TextEncoder().encode(password).byteLength > 1024 || confirmation !== "DELETE") {
      setResult({ state: "rejected", message: "请填写当前密码，并输入 DELETE 以确认永久删除。" }); return;
    }
    pendingPassword.current = password;
    pendingIdentity.current = { id: session.user.id, email: session.user.email };
    setResult(null); setDialog(true);
  }

  async function cleanup(accountId: string | undefined, agentIds: string[], consoleUrn?: string) {
    if (!accountId) return false;
    let complete = true;
    try { clearDeletedAccountLocalRecords(accountId); } catch { complete = false; }
    try {
      const keys = Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index)).filter((key): key is string => !!key);
      for (const key of keys) if (key.startsWith("workbench-pending-actions:") && (consoleUrn ? key.startsWith(`workbench-pending-actions:${consoleUrn}:`) : agentIds.some(id => key.endsWith(":" + id)))) sessionStorage.removeItem(key);
    } catch { complete = false; }
    try { await browserPushTransition(async () => { if (localStorage.getItem(PUSH_OWNER_KEY) === accountId) await clearBrowserPush(); }); } catch { complete = false; }
    return complete;
  }

  async function deleteAccount() {
    if (active.current || !dialog) return;
    const identity = pendingIdentity.current;
    active.current = true; setBusy(true); setDialog(false);
    let current: Session | null = null;
    try { current = await getSession(); } catch { /* Fail closed before the destructive request. */ }
    setSession(current);
    if (!identity || current?.user?.id !== identity.id || current.user.email !== identity.email) {
      pendingPassword.current = ""; setDialog(false);
      active.current = false; setBusy(false);
      setResult({ state: "rejected", message: "当前登录账户已改变或尚未确认，请刷新页面后再操作。" }); return;
    }
    const submitted = pendingPassword.current;
    pendingPassword.current = "";
    const deletedAccountId = identity.id, agentIds = connections.map(connection => connection.id);
    try {
      const outcome = await requestAccountDeletion(submitted, deletedAccountId);
      setResult(outcome);
      if (outcome.state === "deleted") {
        setPassword(""); setConfirmation(""); onDeleted();
        let cleared = false, cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          cleared = await Promise.race([cleanup(deletedAccountId, agentIds, outcome.consoleUrn), new Promise<never>((_, reject) => { cleanupTimer = setTimeout(() => reject(new Error("local cleanup timeout")), 10000); })]);
        } catch { cleared = false; }
        finally { clearTimeout(cleanupTimer); }
        // Even if sign-out cannot reach the server, deleted users no longer pass
        // server-side JWT checks. Do not turn a confirmed deletion into a failure.
        let signOutTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([signOut({ redirect: false }), new Promise<never>((_, reject) => { signOutTimer = setTimeout(() => reject(new Error("sign-out timeout")), 10000); })]);
        } catch { cleared = false; }
        finally { clearTimeout(signOutTimer); }
        // A full document navigation destroys provider-held drafts and snapshots.
        // Query values are presentation hints, never account-state or auth evidence.
        window.location.replace("/login?accountDeleted=true" + (cleared ? "" : "&localCleanup=pending"));
      }
    } finally { active.current = false; setBusy(false); }
  }

  async function checkAccount() {
    if (checking) return;
    setChecking(true); setCheckNotice("");
    try {
      const response = await fetch("/api/auth/account", { cache: "no-store", signal: AbortSignal.timeout(20000) });
      if (response.ok) setCheckNotice("当前仍能读取账户。原请求的最终结果尚未确认，暂不再次提交删除；请稍后重新核实或联系工作区运营者。");
      else if (response.status === 401) setCheckNotice("当前登录已失效，这本身不能证明删除已完成。请返回登录，通过原邮箱登录或找回密码来核实账户状态；仍不明确时联系工作区运营者。");
      else setCheckNotice("暂时无法核实账户状态。请恢复连接后再次核实，或联系工作区运营者。");
    } catch { setCheckNotice("暂时无法核实账户状态。请恢复连接后再次核实，或联系工作区运营者。"); }
    finally { setChecking(false); }
  }

  return <section aria-labelledby="delete-account-title" className="space-y-4 rounded-xl border border-destructive/30 bg-card p-4 sm:p-6">
    <h2 id="delete-account-title" className="text-base font-semibold">删除账户</h2>
    {result?.state === "deleted" ? <>
      <AuthNotice success>{result.message}</AuthNotice>
      <p className="text-sm leading-6 text-muted-foreground">本工作区保存的账户资料、连接、消息副本、草稿、协作记录与提醒已删除。Agent 本机和 Platform 的数据、日志与备份不在这次删除范围内。</p>
      <Button asChild className="min-h-11"><a href="/login">返回登录</a></Button>
    </> : <>
      <p id="delete-account-scope" className="text-sm leading-6 text-muted-foreground">这会永久删除本工作区的账户、控制台身份密钥、连接、已保存的消息与协作副本、草稿、提醒和后台推送订阅，并使所有设备的登录会话失效。删除后无法恢复。</p>
      <p className="text-sm leading-6 text-muted-foreground">删除不会关闭 Agent 本机或清除它和 Platform 保存的数据，也不会撤销本机配对。已派发的操作可能继续完成；需要时请先在 Agent 本机撤销授权。服务日志、备份和邮件提供商保存的数据按运营者的政策处理。</p>
      <Link href="/privacy" className="inline-flex min-h-11 items-center rounded-sm text-sm text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">查看隐私政策与删除范围</Link>
      {result && <AuthNotice>{result.message}</AuthNotice>}
      {result?.state === "uncertain" ? <div className="space-y-3">
        {checkNotice && <AuthNotice>{checkNotice}</AuthNotice>}
        <div className="flex flex-wrap gap-3"><Button type="button" variant="outline" disabled={checking} onClick={checkAccount}>{checking ? "正在核实…" : "核实账户状态"}</Button><Button asChild variant="outline"><a href="/login">返回登录核实</a></Button></div>
      </div> : <form method="post" onSubmit={prepare} className="space-y-5" aria-busy={busy} aria-describedby="delete-account-scope">
        <div className="space-y-2"><Label htmlFor="delete-account-password">当前密码</Label><PasswordInput id="delete-account-password" name="currentPassword" autoComplete="current-password" required disabled={busy} value={password} onChange={event => setPassword(event.target.value)} /></div>
        <div className="space-y-2"><Label htmlFor="delete-account-confirmation">输入 DELETE 确认永久删除</Label><Input id="delete-account-confirmation" name="confirmation" autoComplete="off" autoCapitalize="none" spellCheck={false} required disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></div>
        <Button type="submit" variant="destructive" className="min-h-12 w-full" disabled={busy || !session?.user?.id || !password || confirmation !== "DELETE"}>{busy ? "正在删除…" : "删除账户"}</Button>
      </form>}
      <Dialog open={dialog} onOpenChange={value => { if (!value) pendingPassword.current = ""; setDialog(value); }}>
        <DialogContent>
          <DialogTitle>永久删除账户？</DialogTitle>
          <DialogDescription className="break-all leading-6">你正在删除 {pendingIdentity.current?.email ?? email} 在本工作区的账户及已保存数据。所有登录会话将失效，删除后无法恢复。</DialogDescription>
          <DialogFooter className="gap-3"><Button type="button" variant="outline" onClick={() => { pendingPassword.current = ""; setDialog(false); }}>取消</Button><Button type="button" variant="destructive" onClick={deleteAccount}>永久删除账户</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </>}
  </section>;
}
