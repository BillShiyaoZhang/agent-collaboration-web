"use client";

import { useState, Suspense } from "react";
import { signIn } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowRight, Loader2 } from "lucide-react";
import { safeLoginDestination } from "@/lib/auth/login-destination";
import { AuthNotice, AuthShell, PasswordInput } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = safeLoginDestination(searchParams.get("callbackUrl"));
  const registerHref = searchParams.has("callbackUrl") ? `/register?callbackUrl=${encodeURIComponent(callbackUrl)}` : "/register";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;
    setError("");
    setIsLoading(true);

    try {
      const result = await signIn("credentials", {
        email: email.trim(),
        password,
        redirect: false,
        callbackUrl,
      });

      if (result?.error) {
        setError("邮箱或密码不正确，请检查后重试。");
      } else if (result?.ok) {
        router.push(callbackUrl);
        router.refresh();
        return;
      } else {
        setError("暂时无法登录，请稍后重试。");
      }
    } catch {
      setError("连接失败，请检查网络后重试。");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <AuthShell title="欢迎回来" description="登录 Agent Comm，继续与你的 Agent 协作。">
      <form onSubmit={handleSubmit} className="space-y-5" aria-busy={isLoading}>
        {searchParams.get("registered") === "true" && !error && <AuthNotice success>账号已创建，使用你的邮箱和密码登录。</AuthNotice>}
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
          <Label htmlFor="password">密码</Label>
          <PasswordInput
            id="password"
            name="password"
            autoComplete="current-password"
            placeholder="输入你的密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            disabled={isLoading}
          />
        </div>
        <Button type="submit" className="h-12 w-full gap-2 rounded-xl" disabled={isLoading}>
          {isLoading ? <><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在登录…</> : <>进入工作空间<ArrowRight className="h-4 w-4" aria-hidden="true" /></>}
        </Button>
      </form>
      <p className="mt-7 text-center text-sm text-muted-foreground">
        还没有账号？{" "}
        <Link href={registerHref} className="inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">创建账号</Link>
      </p>
    </AuthShell>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="flex min-h-full items-center justify-center gap-2 p-12 text-sm text-muted-foreground" role="status"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在加载…</div>}>
      <LoginForm />
    </Suspense>
  );
}
