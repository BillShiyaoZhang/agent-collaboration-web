"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { safeLoginDestination } from "@/lib/auth/login-destination";
import { AuthNotice, AuthShell, PasswordInput } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function RegisterForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = safeLoginDestination(searchParams.get("callbackUrl"));
  const callbackQuery = searchParams.has("callbackUrl") ? `callbackUrl=${encodeURIComponent(callbackUrl)}` : "";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setError("");

    if (password.length < 8) {
      setError("密码至少需要 8 个字符。");
      return;
    }
    if (new TextEncoder().encode(password).byteLength > 1024) {
      setError("密码过长，请使用不超过 1024 字节的密码。");
      return;
    }
    if (password !== confirmPassword) {
      setError("两次输入的密码不一致，请重新确认。");
      return;
    }

    setIsLoading(true);
    try {
      const response = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), password }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        if (response.status === 409) {
          setError("这个邮箱已注册，可以直接登录。");
        } else if (data.error === "Invalid email address") {
          setError("请输入有效的邮箱地址。");
        } else if (data.error === "Password must be at least 8 characters") {
          setError("密码至少需要 8 个字符。");
        } else {
          setError("暂时无法创建账号，请稍后重试。");
        }
        setIsLoading(false);
        return;
      }

      router.push(`/login?registered=true${callbackQuery ? `&${callbackQuery}` : ""}`);
    } catch {
      setError("连接失败，请检查网络后重试。");
      setIsLoading(false);
    }
  };

  return (
    <AuthShell title="开启新的协作" description="创建账号，把你的 Agent 连接到同一个工作空间。">
      <form onSubmit={handleSubmit} className="space-y-5" aria-busy={isLoading}>
        {error && <AuthNotice>{error}</AuthNotice>}
        <div className="space-y-2">
          <Label htmlFor="email">邮箱</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            disabled={isLoading}
            className="h-12 rounded-xl text-base sm:text-sm"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">设置密码</Label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="new-password"
            placeholder="至少 8 个字符"
            aria-describedby="password-hint"
            minLength={8}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={isLoading}
          />
          <p id="password-hint" className="text-xs leading-5 text-muted-foreground">至少 8 个字符，建议组合使用字母、数字和符号。</p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="confirmPassword">确认密码</Label>
          <PasswordInput
            id="confirmPassword"
            name="confirmPassword"
            autoComplete="new-password"
            placeholder="再次输入密码"
            minLength={8}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            disabled={isLoading}
          />
        </div>
        <Button type="submit" className="h-12 w-full gap-2 rounded-xl" disabled={isLoading}>
          {isLoading ? <><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在创建账号…</> : <>创建账号<ArrowRight className="h-4 w-4" aria-hidden="true" /></>}
        </Button>
      </form>
      <p className="mt-7 text-center text-sm text-muted-foreground">
        已有账号？{" "}
        <Link href={`/login${callbackQuery ? `?${callbackQuery}` : ""}`} className="inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">直接登录</Link>
      </p>
    </AuthShell>
  );
}

export default function RegisterPage() {
  return (
    <Suspense fallback={<div className="flex min-h-full items-center justify-center gap-2 p-12 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在加载…</div>}>
      <RegisterForm />
    </Suspense>
  );
}
