"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AuthNotice, PasswordInput } from "@/components/auth-shell";
import { emailActionError, passwordValidation, postEmailAction } from "@/components/email-auth-flow";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

type Account = { email: string; emailVerified: boolean; verificationRequired: boolean };

export default function AccountSettingsPage() {
  const [account, setAccount] = useState<Account | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [revision, setRevision] = useState(0);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState("");
  const [verifyNotice, setVerifyNotice] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState("");
  const [passwordNotice, setPasswordNotice] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError("");
    async function load() {
      try {
        const response = await fetch("/api/auth/account", { cache: "no-store", signal: controller.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { setLoadError(emailActionError(response.status, data)); return; }
        if (typeof data.email !== "string" || typeof data.emailVerified !== "boolean" || typeof data.verificationRequired !== "boolean") { setLoadError("账户信息暂时不可用，请重试。"); return; }
        setAccount(data);
      } catch { if (!controller.signal.aborted) setLoadError("无法读取账户信息，请检查网络后重试。"); }
      finally { if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    return () => controller.abort();
  }, [revision]);

  async function resendVerification() {
    if (!account || verifyBusy) return;
    setVerifyBusy(true); setVerifyError(""); setVerifyNotice("");
    try {
      const result = await postEmailAction("resend-verification", { email: account.email, callbackUrl: "/dashboard/settings" });
      if (!result.ok) setVerifyError(emailActionError(result.status, result.data));
      else setVerifyNotice("如果此邮箱需要验证，系统会尝试发送验证邮件。请检查收件箱和垃圾邮件。");
    } catch { setVerifyError("连接失败，请检查网络后重试。"); }
    finally { setVerifyBusy(false); }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault();
    if (!account || passwordBusy) return;
    const validation = passwordValidation(password, confirmation);
    setPasswordError(validation); setPasswordNotice("");
    if (validation) return;
    setPasswordBusy(true);
    try {
      const result = await postEmailAction("change-password", { currentPassword, password });
      if (!result.ok) { setPasswordError(emailActionError(result.status, result.data)); return; }
      setCurrentPassword(""); setPassword(""); setConfirmation("");
      setPasswordNotice("修改请求已提交，请查收邮件并确认。确认前当前密码仍然有效；确认后所有已登录的会话将退出，请使用新密码重新登录。");
    } catch { setPasswordError("连接失败，请检查网络后重试。"); }
    finally { setPasswordBusy(false); }
  }

  return <div className="mx-auto w-full max-w-xl space-y-6 pb-6">
    <div><Link href="/dashboard/me" className="inline-flex min-h-11 items-center rounded-sm text-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">返回“我”</Link><h1 className="text-xl font-semibold">邮箱与密码</h1></div>
    {loading && <p role="status" className="text-sm text-muted-foreground">正在读取账户信息…</p>}
    {loadError && <div className="space-y-3"><AuthNotice>{loadError}</AuthNotice><Button type="button" variant="outline" onClick={() => setRevision(value => value + 1)}>重新读取</Button><Link href="/login" className="ml-3 text-sm text-primary">重新登录</Link></div>}
    {account && !loading && !loadError && <>
      <section aria-labelledby="email-title" className="space-y-4 rounded-xl border bg-card p-4 sm:p-6">
        <h2 id="email-title" className="text-base font-semibold">账户邮箱</h2>
        <p className="break-all text-sm">{account.email}</p>
        <p className="text-sm leading-6 text-muted-foreground">{account.emailVerified ? "邮箱已验证。" : account.verificationRequired ? "邮箱尚未验证，请完成验证后继续使用账号。" : "邮箱尚未验证。已有账户可继续登录，建议补充验证，以便确认邮箱归属。"}</p>
        {verifyError && <AuthNotice>{verifyError}</AuthNotice>}
        {verifyNotice && <AuthNotice success>{verifyNotice}</AuthNotice>}
        {!account.emailVerified && <Button type="button" variant="outline" className="min-h-11" disabled={verifyBusy} onClick={resendVerification}>{verifyBusy ? "正在提交…" : "发送验证邮件"}</Button>}
      </section>
      <section aria-labelledby="password-title" className="space-y-4 rounded-xl border bg-card p-4 sm:p-6">
        <h2 id="password-title" className="text-base font-semibold">修改密码</h2>
        <p className="text-sm leading-6 text-muted-foreground">验证当前密码后，我们会向账户邮箱发送确认邮件。打开邮件并确认后，新密码才会生效。</p>
        <form method="post" onSubmit={changePassword} className="space-y-5" aria-busy={passwordBusy}>
          {passwordError && <AuthNotice>{passwordError}</AuthNotice>}
          {passwordNotice && <AuthNotice success>{passwordNotice}</AuthNotice>}
          <div className="space-y-2"><Label htmlFor="current-password">当前密码</Label><PasswordInput id="current-password" name="currentPassword" autoComplete="current-password" required disabled={passwordBusy} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></div>
          <div className="space-y-2"><Label htmlFor="new-password">新密码</Label><PasswordInput id="new-password" name="password" autoComplete="new-password" minLength={8} required disabled={passwordBusy} aria-describedby="password-hint" value={password} onChange={event => setPassword(event.target.value)} /><p id="password-hint" className="text-xs leading-5 text-muted-foreground">至少 8 个字符，建议组合使用字母、数字和符号。</p></div>
          <div className="space-y-2"><Label htmlFor="confirm-password">确认新密码</Label><PasswordInput id="confirm-password" name="confirmation" autoComplete="new-password" minLength={8} required disabled={passwordBusy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></div>
          <Button className="h-12 w-full rounded-xl" disabled={passwordBusy}>{passwordBusy ? "正在提交…" : "发送密码修改确认邮件"}</Button>
        </form>
        <p className="text-sm"><Link href="/forgot-password" className="inline-flex min-h-11 items-center rounded-sm text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">忘记当前密码？通过邮件重置</Link></p>
      </section>
    </>}
  </div>;
}
