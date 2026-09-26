"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { signOut } from "next-auth/react";
import { Loader2 } from "lucide-react";
import { AuthNotice, AuthShell, PasswordInput } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeLoginDestination } from "@/lib/auth/login-destination";
import { publicSupportEmail } from "@/lib/shared/support-email";

type EmailAction = "register" | "resend-verification" | "verify-email" | "forgot-password" | "reset-password" | "change-password" | "confirm-password-change";
type EmailResult = { ok: boolean; status: number; data: Record<string, unknown> };

export async function postEmailAction(action: EmailAction, payload: Record<string, unknown>): Promise<EmailResult> {
  const response = await fetch(`/api/auth/${action}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const body: unknown = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data: body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {} };
}

export function emailActionError(status: number, data: Record<string, unknown>): string {
  if (status === 429) return "请求过于频繁，请稍后再试。";
  if (status === 503) return publicSupportEmail() ? "邮件服务暂时不可用，请稍后重试或联系人工客服。" : "邮件服务暂时不可用，请稍后重试。";
  if (data.code === "INVALID_TOKEN") return "此链接无效、已过期或已使用，请重新申请邮件。";
  if (data.code === "INVALID_PASSWORD") return "当前密码不正确，请检查后重试。";
  if (data.code === "INVALID_INPUT" && typeof data.error === "string") return data.error;
  if (status === 401) return "登录已失效，请重新登录后再试。";
  if (status === 403) return "无法完成此请求，请刷新页面后重试。";
  return "暂时无法完成操作，请稍后重试。";
}

export function passwordValidation(password: string, confirmation: string): string {
  if (password.length < 8) return "密码至少需要 8 个字符。";
  if (new TextEncoder().encode(password).byteLength > 1024) return "密码过长，请使用不超过 1024 字节的密码。";
  if (password !== confirmation) return "两次输入的密码不一致，请重新确认。";
  return "";
}

function Loading() {
  return <div className="flex min-h-full items-center justify-center gap-2 p-12 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在加载…</div>;
}

const linkStyle = "inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function RequestForm({ mode }: { mode: "verify" | "forgot" }) {
  const search = useSearchParams();
  const callbackUrl = safeLoginDestination(search.get("callbackUrl"));
  const loginHref = `/login${search.has("callbackUrl") ? `?callbackUrl=${encodeURIComponent(callbackUrl)}` : ""}`;
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const verifying = mode === "verify";
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await postEmailAction(verifying ? "resend-verification" : "forgot-password", { email: email.trim(), ...(verifying ? { callbackUrl } : {}) });
      if (!result.ok) setError(emailActionError(result.status, result.data));
      else setNotice(verifying ? "如果此邮箱需要验证，系统会尝试发送验证邮件。请检查收件箱和垃圾邮件，并在邮件中确认。" : "如果此邮箱已有账号，系统会尝试发送重置密码邮件。请检查收件箱和垃圾邮件。");
    } catch { setError("连接失败，请检查网络后重试。"); }
    finally { setBusy(false); }
  }
  return <AuthShell title={verifying ? "重新验证邮箱" : "找回密码"} description={verifying ? "输入注册时的邮箱，申请新的验证链接。" : "输入账号邮箱，通过邮件设置新密码。"}>
    <form method="post" onSubmit={submit} className="space-y-5" aria-busy={busy}>
      {error && <AuthNotice>{error}</AuthNotice>}
      {notice && <AuthNotice success>{notice}</AuthNotice>}
      <div className="space-y-2"><Label htmlFor="email">邮箱</Label><Input id="email" name="email" type="email" autoComplete="email" autoCapitalize="none" spellCheck={false} value={email} onChange={event => setEmail(event.target.value)} placeholder="you@example.com" required disabled={busy} className="h-12 rounded-xl text-base" /></div>
      <Button className="h-12 w-full rounded-xl" disabled={busy}>{busy ? "正在提交…" : notice ? "重新发送邮件" : verifying ? "发送验证邮件" : "发送重置邮件"}</Button>
    </form>
    <p className="mt-7 text-center text-sm"><Link href={loginHref} className={linkStyle}>返回登录</Link></p>
  </AuthShell>;
}

export function EmailRequestPage({ mode }: { mode: "verify" | "forgot" }) {
  return <Suspense fallback={<Loading />}><RequestForm mode={mode} /></Suspense>;
}

type TokenMode = "verify" | "reset" | "confirm";
const tokenText = {
  verify: { title: "验证你的邮箱", description: "确认后即可完成邮箱验证，继续登录工作空间。", action: "verify-email", button: "确认验证邮箱", success: "邮箱验证完成，请使用你的邮箱和密码登录。", retry: "/resend-verification", retryLabel: "重新申请验证邮件", flag: "verified" },
  reset: { title: "设置新密码", description: "确认新密码后生效，所有已登录的会话将退出。", action: "reset-password", button: "确认重置密码", success: "密码已重置，所有已登录的会话已失效。请使用新密码重新登录。", retry: "/forgot-password", retryLabel: "重新申请重置邮件", flag: "passwordReset" },
  confirm: { title: "确认修改密码", description: "确认后，账户设置中提交的新密码才会生效。", action: "confirm-password-change", button: "确认修改密码", success: "密码已修改，所有已登录的会话已失效。请使用新密码重新登录。", retry: "/dashboard/settings", retryLabel: "返回账户设置重新申请", flag: "passwordChanged" },
} as const;

function TokenForm({ mode }: { mode: TokenMode }) {
  const search = useSearchParams();
  const token = search.get("token") || "";
  const text = tokenText[mode];
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [callbackUrl, setCallbackUrl] = useState(safeLoginDestination(search.get("callbackUrl")));
  const loginHref = `/login?${text.flag}=true${mode === "verify" ? `&callbackUrl=${encodeURIComponent(callbackUrl)}` : ""}`;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || done || !token) return;
    setError("");
    if (mode === "reset") {
      const validation = passwordValidation(password, confirmation);
      if (validation) { setError(validation); return; }
    }
    setBusy(true);
    try {
      const result = await postEmailAction(text.action, { token, ...(mode === "reset" ? { password } : {}) });
      if (!result.ok) { setError(emailActionError(result.status, result.data)); return; }
      if (typeof result.data.callbackUrl === "string") setCallbackUrl(safeLoginDestination(result.data.callbackUrl));
      setDone(true); setPassword(""); setConfirmation("");
      window.history.replaceState(null, "", window.location.pathname);
    } catch { setError("连接失败，请检查网络后重试。"); }
    finally { setBusy(false); }
  }
  async function loginAgain() {
    if (busy) return;
    setBusy(true); setError("");
    try { await signOut({ callbackUrl: loginHref }); }
    catch { setError("暂时无法退出旧会话，请刷新页面后重新登录。"); setBusy(false); }
  }
  return <AuthShell title={text.title} description={text.description}>
    <div className="space-y-5">
      {error && <AuthNotice>{error}</AuthNotice>}
      {done ? <>
        <AuthNotice success>{text.success}</AuthNotice>
        {mode === "verify" ? <Button asChild className="h-12 w-full rounded-xl"><Link href={loginHref}>前往登录</Link></Button> : <Button type="button" className="h-12 w-full rounded-xl" disabled={busy} onClick={loginAgain}>{busy ? "正在退出旧会话…" : "使用新密码重新登录"}</Button>}
      </> : !token ? <>
        <AuthNotice>链接缺少验证信息，请从邮件中打开完整链接，或重新申请邮件。</AuthNotice>
        <Link href={text.retry} className={linkStyle}>{text.retryLabel}</Link>
      </> : <form method="post" onSubmit={submit} className="space-y-5" aria-busy={busy}>
        {mode === "reset" ? <>
          <div className="space-y-2"><Label htmlFor="password">新密码</Label><PasswordInput id="password" name="password" autoComplete="new-password" minLength={8} required disabled={busy} aria-describedby="password-hint" value={password} onChange={event => setPassword(event.target.value)} /><p id="password-hint" className="text-xs leading-5 text-muted-foreground">至少 8 个字符，建议组合使用字母、数字和符号。</p></div>
          <div className="space-y-2"><Label htmlFor="confirmation">确认新密码</Label><PasswordInput id="confirmation" name="confirmation" autoComplete="new-password" minLength={8} required disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></div>
        </> : <p className="text-sm leading-6 text-muted-foreground">点击下方按钮确认此操作。如果这不是你发起的请求，请关闭此页面。</p>}
        <Button className="h-12 w-full rounded-xl" disabled={busy}>{busy ? "正在确认…" : text.button}</Button>
        <p className="text-sm"><Link href={text.retry} className={linkStyle}>{text.retryLabel}</Link></p>
      </form>}
    </div>
  </AuthShell>;
}

export function EmailTokenPage({ mode }: { mode: TokenMode }) {
  return <Suspense fallback={<Loading />}><TokenForm mode={mode} /></Suspense>;
}
