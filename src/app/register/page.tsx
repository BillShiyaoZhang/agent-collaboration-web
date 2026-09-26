"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { safeLoginDestination } from "@/lib/auth/login-destination";
import { AuthNotice, AuthShell, PasswordInput } from "@/components/auth-shell";
import { emailActionError, passwordValidation, postEmailAction } from "@/components/email-auth-flow";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function RegisterForm() {
  const searchParams = useSearchParams();
  const callbackUrl = safeLoginDestination(searchParams.get("callbackUrl"));
  const callbackQuery = searchParams.has("callbackUrl") ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [notice, setNotice] = useState("");

  async function resend() {
    if (isLoading) return;
    setError(""); setNotice(""); setIsLoading(true);
    try {
      const result = await postEmailAction("resend-verification", { email: email.trim(), callbackUrl });
      if (!result.ok) setError(emailActionError(result.status, result.data));
      else setNotice("如果此邮箱需要验证，系统会尝试发送新的验证邮件。请检查收件箱和垃圾邮件。");
    } catch { setError("连接失败，请检查网络后重试。"); }
    finally { setIsLoading(false); }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (isLoading) return;
    const validation = passwordValidation(password, confirmPassword);
    setError(validation);
    if (validation) return;
    setIsLoading(true);
    try {
      const result = await postEmailAction("register", { email: email.trim(), password, callbackUrl });
      if (!result.ok) { setError(emailActionError(result.status, result.data)); return; }
      setSubmitted(true); setPassword(""); setConfirmPassword("");
      setNotice("如果此邮箱可以注册或需要验证，系统会尝试发送验证邮件。请打开邮件中的链接并确认，然后登录。已有账号可直接登录。");
    } catch { setError("连接失败，请检查网络后重试。"); }
    finally { setIsLoading(false); }
  }

  return <AuthShell title={submitted ? "请查收验证邮件" : "开启新的协作"} description={submitted ? "验证你的邮箱后，即可使用账号登录工作空间。" : "创建账号，把你的 Agent 连接到同一个工作空间。"}>
    {submitted ? <div className="space-y-5" aria-busy={isLoading}>
      {error && <AuthNotice>{error}</AuthNotice>}
      {notice && <AuthNotice success>{notice}</AuthNotice>}
      <p className="break-all text-sm leading-6 text-muted-foreground">提交的邮箱：{email.trim()}</p>
      <p className="text-sm leading-6 text-muted-foreground">没有找到邮件？检查垃圾邮件，或稍后重新发送。验证链接仅能使用一次。</p>
      <Button type="button" variant="outline" className="h-12 w-full rounded-xl" disabled={isLoading} onClick={resend}>{isLoading ? "正在提交…" : "重新发送验证邮件"}</Button>
      <Button type="button" variant="ghost" className="h-11 w-full rounded-xl" disabled={isLoading} onClick={() => { setSubmitted(false); setNotice(""); setError(""); }}>修改邮箱重新注册</Button>
    </div> : <form method="post" onSubmit={handleSubmit} className="space-y-5" aria-busy={isLoading}>
      {error && <AuthNotice>{error}</AuthNotice>}
      <div className="space-y-2"><Label htmlFor="email">邮箱</Label><Input id="email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} placeholder="you@example.com" value={email} onChange={e => setEmail(e.target.value)} required disabled={isLoading} className="h-12 rounded-xl text-base" /></div>
      <div className="space-y-2"><Label htmlFor="password">设置密码</Label><PasswordInput id="password" name="password" autoComplete="new-password" placeholder="至少 8 个字符" aria-describedby="password-hint" minLength={8} value={password} onChange={e => setPassword(e.target.value)} required disabled={isLoading} /><p id="password-hint" className="text-xs leading-5 text-muted-foreground">至少 8 个字符，建议组合使用字母、数字和符号。</p></div>
      <div className="space-y-2"><Label htmlFor="confirmPassword">确认密码</Label><PasswordInput id="confirmPassword" name="confirmPassword" autoComplete="new-password" placeholder="再次输入密码" minLength={8} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)} required disabled={isLoading} /></div>
      <p className="text-xs leading-5 text-muted-foreground">注册后需通过邮件验证邮箱，请使用你能够收信的地址。</p>
      <Button type="submit" className="h-12 w-full gap-2 rounded-xl" disabled={isLoading}>{isLoading ? <><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在提交注册…</> : <>创建账号<ArrowRight className="h-4 w-4" aria-hidden="true" /></>}</Button>
    </form>}
    <p className="mt-7 text-center text-sm text-muted-foreground">已有账号？ <Link href={`/login${callbackQuery}`} className="inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">直接登录</Link></p>
  </AuthShell>;
}

export default function RegisterPage() {
  return <Suspense fallback={<div className="flex min-h-full items-center justify-center gap-2 p-12 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在加载…</div>}><RegisterForm /></Suspense>;
}
