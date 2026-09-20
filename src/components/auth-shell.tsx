"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowUpRight, Bot, CheckCircle2, Eye, EyeOff, Info, MessageSquare, Network } from "lucide-react";
import { Input, type InputProps } from "@/components/ui/input";
import { Brand } from "@/components/brand";

export function AuthShell({ title, description, children }: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto grid min-h-full w-full max-w-[1600px] lg:grid-cols-[1fr_0.95fr]">
      <section className="flex flex-col px-6 py-6 sm:px-12 lg:px-16 lg:py-8 xl:px-24">
        <div className="flex items-center justify-between gap-4">
          <Link href="/" aria-label="Agent Comm 首页" className="rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-4">
            <Brand />
          </Link>
          <Link href="/" className="inline-flex min-h-11 items-center gap-1.5 rounded-lg text-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
            首页
          </Link>
        </div>

        <div className="mx-auto flex w-full max-w-[380px] flex-1 flex-col justify-center py-12 sm:py-16 lg:py-12">
          <div className="mb-8">
            <p className="mb-3 text-xs font-semibold uppercase tracking-[0.2em] text-primary">你的协作空间</p>
            <h1 className="text-3xl font-semibold tracking-tight sm:text-[34px]">{title}</h1>
            <p className="mt-3 text-sm leading-6 text-muted-foreground">{description}</p>
          </div>
          {children}
        </div>
      </section>

      <aside className="relative m-4 ml-0 hidden overflow-hidden rounded-[28px] bg-[#eaf2ed] px-12 py-12 text-[#233e33] lg:flex lg:flex-col lg:justify-between xl:px-16" aria-label="关于 Agent Comm">
        <div className="relative z-10 flex items-center gap-2 text-xs font-medium tracking-[0.18em] text-[#507062]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#57846c]" />
          连接 · 沟通 · 协作
        </div>

        <div className="relative z-10 py-10">
          <h2 className="text-4xl font-semibold leading-[1.3] tracking-tight xl:text-5xl">让每个 Agent，<br />成为你的协作伙伴。</h2>
          <p className="mt-5 max-w-sm text-sm leading-7 text-[#587165]">在一个工作空间里连接 Agent、交流想法，<br className="hidden xl:block" />让协作自然发生。</p>

          <div className="relative mt-12 max-w-md" aria-hidden="true">
            <div className="relative z-10 flex items-center gap-4 rounded-2xl border border-white/90 bg-white/90 p-5 shadow-[0_8px_35px_-20px_rgba(35,62,51,0.3)]">
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#233e33] text-white"><Network className="h-6 w-6" strokeWidth={1.5} /></div>
              <div className="flex-1"><p className="text-sm font-semibold">你的工作空间</p><p className="mt-1 text-xs text-[#52695b]">人与 Agent，从这里连接</p></div>
              <ArrowUpRight className="h-5 w-5 text-[#8ca598]" />
            </div>
            <div className="mx-auto h-7 w-px bg-[#bdcfc3]" />
            <div className="relative mx-auto h-5 w-[52%] rounded-t-xl border-x border-t border-[#bdcfc3]" />
            <div className="grid grid-cols-2 gap-4">
              <div className="rounded-2xl border border-white/80 bg-white/60 p-5"><Bot className="mb-4 h-6 w-6 text-[#507662]" strokeWidth={1.5} /><p className="text-sm font-medium">管理 Agent</p><p className="mt-1.5 text-xs text-[#52695b]">连接你的智能伙伴</p></div>
              <div className="rounded-2xl border border-white/80 bg-white/60 p-5"><MessageSquare className="mb-4 h-6 w-6 text-[#507662]" strokeWidth={1.5} /><p className="text-sm font-medium">开始对话</p><p className="mt-1.5 text-xs text-[#52695b]">让沟通触手可及</p></div>
            </div>
          </div>
        </div>

        <p className="relative z-10 text-xs text-[#52695b]">为人与 Agent 的日常协作而设计。</p>
        <div className="pointer-events-none absolute -bottom-52 -right-48 h-[540px] w-[540px] rounded-full border border-[#dbe7df]" aria-hidden="true" />
        <div className="pointer-events-none absolute -bottom-36 -right-32 h-[410px] w-[410px] rounded-full border border-[#dbe7df]" aria-hidden="true" />
      </aside>
    </main>
  );
}

export function PasswordInput({ className = "", ...props }: Omit<InputProps, "type">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <Input {...props} type={visible ? "text" : "password"} className={`h-12 rounded-xl pr-12 text-base ${className}`} />
      <button
        type="button"
        aria-label={visible ? "隐藏密码" : "显示密码"}
        aria-pressed={visible}
        aria-controls={props.id}
        disabled={props.disabled}
        onClick={() => setVisible(!visible)}
        className="absolute right-0 top-0 flex h-12 w-12 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {visible ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
      </button>
    </div>
  );
}

export function AuthNotice({ children, success = false }: { children: string; success?: boolean }) {
  const notice = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!success) notice.current?.focus();
  }, [children, success]);

  return (
    <div
      ref={notice}
      role={success ? "status" : "alert"}
      tabIndex={-1}
      className={`flex items-start gap-2.5 rounded-xl border p-3.5 text-sm leading-6 outline-none ${success ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-destructive/20 bg-destructive/5 text-destructive"}`}
    >
      {success ? <CheckCircle2 className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" /> : <Info className="mt-1 h-4 w-4 shrink-0" aria-hidden="true" />}
      <span>{children}</span>
    </div>
  );
}
