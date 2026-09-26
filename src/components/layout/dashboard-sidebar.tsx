"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Bell, BookOpen, Cable, CircleHelp, House, Layers3, LockKeyhole, Terminal } from "lucide-react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function ConnectionGuide() {
  return <Dialog>
    <DialogTrigger asChild><Button variant="ghost" className="w-full justify-start gap-3 text-muted-foreground"><CircleHelp className="h-4 w-4" />连接指南<ArrowUpRight className="ml-auto h-3.5 w-3.5" /></Button></DialogTrigger>
    <DialogContent>
      <DialogHeader><DialogTitle>把 Hermes 连接到工作台</DialogTitle><DialogDescription>让已经能正常使用的 Hermes 发起连接，再在网页核对并授权。</DialogDescription></DialogHeader>
      <ol className="my-2 space-y-6">
        {[
          { icon: Terminal, title: "让 Hermes 发起连接", text: "在 Hermes 中说“安装并配置：https://agent-communication.online”。它会按官网指南准备组件，并给你一次性网页连接链接。" },
          { icon: LockKeyhole, title: "在网页核对并授权", text: "登录后打开 Hermes 给出的链接，核对 agent、功能和到期时间，再确认授权。连接会自动加入“我的连接”。" },
          { icon: Cable, title: "检查连接和真实回复", text: "等 Hermes 完成本机配对，打开工作台检查连接，发送测试消息；收到完成状态和实际答复才算连通。" },
        ].map((step, index) => <li key={step.title} className="flex gap-4"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary"><step.icon className="h-5 w-5" /></span><div><h3 className="text-sm font-semibold"><span className="mr-2 text-muted-foreground">0{index + 1}</span>{step.title}</h3><p className="mt-1.5 text-sm leading-6 text-muted-foreground">{step.text}</p></div></li>)}
      </ol>
      <p className="rounded-xl bg-muted/70 p-3 text-xs leading-5 text-muted-foreground">已手工安装连接组件的 agent，仍可在“我的连接”中使用“添加连接”，并在本机配对。注册账户本身不会创建 agent。</p>
      <Button asChild variant="outline" className="w-full"><Link href="/#start">查看官网接入步骤<ArrowUpRight className="ml-2 h-4 w-4" /></Link></Button>
    </DialogContent>
  </Dialog>;
}

export function DashboardNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return <div className="flex h-full flex-col">
    <Link href="/dashboard/agents" onClick={onNavigate} aria-label="Agent Comm 我的连接" className="self-start rounded-lg"><Brand /></Link>
    <div className="mt-10 px-3 text-xs font-semibold tracking-[0.18em] text-muted-foreground">个人工作空间</div>
    <nav aria-label="主导航" className="mt-3">
      <Link href="/dashboard/agents" onClick={onNavigate} aria-current={pathname.startsWith("/dashboard/agents") ? "page" : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors hover:bg-primary/10 ${pathname.startsWith("/dashboard/agents") ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground"}`}><Layers3 className="h-[18px] w-[18px]" />我的连接</Link>
      <Link href="/dashboard/notifications" onClick={onNavigate} aria-current={pathname === "/dashboard/notifications" ? "page" : undefined} className={`mt-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors hover:bg-primary/10 ${pathname === "/dashboard/notifications" ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground"}`}><Bell className="h-[18px] w-[18px]" />提醒中心</Link>
    </nav>
    <nav aria-label="站点导航" className="mt-5 border-t pt-3">
      <Link href="/" onClick={onNavigate} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><House className="h-4 w-4" />首页</Link>
      <Link href="/docs" onClick={onNavigate} className="flex items-center gap-3 rounded-xl px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><BookOpen className="h-4 w-4" />文档</Link>
    </nav>
    <div className="mt-auto pt-10">
      <ConnectionGuide />
      <div className="mt-4 flex items-center gap-2 border-t px-3 pt-4 text-xs tracking-wide text-muted-foreground"><LockKeyhole className="h-3 w-3" />本机授权 · 远程协作</div>
    </div>
  </div>;
}
export function DashboardSidebar() {
  return <aside className="hidden w-60 shrink-0 border-r bg-card/70 p-5 lg:block"><DashboardNavigation /></aside>;
}
