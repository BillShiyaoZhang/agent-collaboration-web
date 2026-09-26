"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Bell, BookOpen, Cable, CircleHelp, House, Layers3, LockKeyhole, Terminal, MessageCircle, Users, Handshake, UserRound } from "lucide-react";
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
    <Link href="/dashboard" onClick={onNavigate} aria-label="Agent Comm 我的 agents" className="flex min-h-10 items-center self-start rounded-md px-1"><Brand compact /><span className="ml-2 text-sm font-semibold">Agent Comm</span></Link>
    <nav aria-label="主导航" className="mt-4 space-y-1">{primaryNavigation.map(item => <Link key={item.href} href={item.href} onClick={onNavigate} aria-current={activeNavigation(pathname, item.href) ? "page" : undefined} className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors hover:bg-primary/10 ${activeNavigation(pathname, item.href) ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground"}`}><item.icon className="h-[18px] w-[18px]" />{item.label}</Link>)}
      <Link href="/dashboard/agents" onClick={onNavigate} className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted"><Layers3 className="h-[18px] w-[18px]" />我的连接</Link>
      <Link href="/dashboard/notifications" onClick={onNavigate} className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted"><Bell className="h-[18px] w-[18px]" />提醒中心</Link>
    </nav>
    <nav aria-label="站点导航" className="mt-4 border-t pt-2">
      <Link href="/" onClick={onNavigate} className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><House className="h-4 w-4" />首页</Link>
      <Link href="/docs" onClick={onNavigate} className="flex items-center gap-3 rounded-md px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"><BookOpen className="h-4 w-4" />文档</Link>
    </nav>
    <div className="mt-auto pt-4">
      <ConnectionGuide />
    </div>
  </div>;
}
export function DashboardSidebar() {
  return <aside className="hidden w-44 shrink-0 border-r bg-card p-2 md:block"><DashboardNavigation /></aside>;
}

const primaryNavigation = [
  { href: "/dashboard/chats", label: "我的 agents", icon: MessageCircle },
  { href: "/dashboard/collaborations", label: "合作", icon: Handshake },
  { href: "/dashboard/contacts", label: "联系人", icon: Users },
  { href: "/dashboard/me", label: "我", icon: UserRound },
];
function activeNavigation(pathname: string, href: string) {
  return pathname === href || (href === "/dashboard/chats" && pathname.startsWith("/dashboard/agents/"));
}
export function MobileNavigation() {
  const pathname = usePathname();
  return <nav aria-label="手机主导航" className="grid shrink-0 grid-cols-4 border-t bg-card pb-[env(safe-area-inset-bottom)] md:hidden">{primaryNavigation.map(item => <Link key={item.href} href={item.href} aria-current={activeNavigation(pathname,item.href) ? "page" : undefined} className={`flex min-h-12 flex-col items-center justify-center gap-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring ${activeNavigation(pathname,item.href) ? "font-semibold text-primary" : "text-muted-foreground"}`}><item.icon className="h-5 w-5" />{item.label}</Link>)}</nav>;
}
