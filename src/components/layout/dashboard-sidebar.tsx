"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Bell, Cable, CircleHelp, Layers3, LockKeyhole, Terminal } from "lucide-react";
import { Brand } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function ConnectionGuide() {
  return <Dialog>
    <DialogTrigger asChild><Button variant="ghost" className="w-full justify-start gap-3 text-muted-foreground"><CircleHelp className="h-4 w-4" />连接指南<ArrowUpRight className="ml-auto h-3.5 w-3.5" /></Button></DialogTrigger>
    <DialogContent>
      <DialogHeader><DialogTitle>把自己的 agent 带到这里</DialogTitle><DialogDescription>首次连接只需完成以下三步，之后就可以直接打开工作台。</DialogDescription></DialogHeader>
      <ol className="my-2 space-y-6">
        {[
          { icon: Terminal, title: "准备 agent", text: "在 agent 所在的设备上安装 agent-comm、对应 connector 与 helper，保持它们运行，并取得完整的 agent URN。" },
          { icon: Cable, title: "添加连接", text: "点击“添加连接”，给它起一个容易识别的名字，粘贴 URN。验证身份后会进入工作台。" },
          { icon: LockKeyhole, title: "在本机完成配对", text: "按照工作台的配对引导创建控制台身份，在 agent 本机授权该身份，再回到工作台读取可用功能。" },
        ].map((step, index) => <li key={step.title} className="flex gap-4"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-primary"><step.icon className="h-5 w-5" /></span><div><h3 className="text-sm font-semibold"><span className="mr-2 text-muted-foreground">0{index + 1}</span>{step.title}</h3><p className="mt-1.5 text-sm leading-6 text-muted-foreground">{step.text}</p></div></li>)}
      </ol>
      <p className="rounded-xl bg-muted/70 p-3 text-xs leading-5 text-muted-foreground">联系人、事项和对话来自你的 agent。可使用的功能由本机授权决定。</p>
    </DialogContent>
  </Dialog>;
}

export function DashboardNavigation({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return <div className="flex h-full flex-col">
    <Link href="/dashboard/agents" onClick={onNavigate} aria-label="Agent Comm 我的连接" className="self-start rounded-lg"><Brand /></Link>
    <div className="mt-10 px-3 text-xs font-semibold tracking-[0.18em] text-muted-foreground">个人工作空间</div>
    <nav aria-label="主导航" className="mt-3">
      <Link href="/dashboard/agents" onClick={onNavigate} aria-current={pathname === "/dashboard/agents" ? "page" : undefined} className={`flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors hover:bg-primary/10 ${pathname !== "/dashboard/notifications" ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground"}`}><Layers3 className="h-[18px] w-[18px]" />我的连接</Link>
      <Link href="/dashboard/notifications" onClick={onNavigate} aria-current={pathname === "/dashboard/notifications" ? "page" : undefined} className={`mt-1 flex items-center gap-3 rounded-xl px-3 py-3 text-sm transition-colors hover:bg-primary/10 ${pathname === "/dashboard/notifications" ? "bg-primary/10 font-semibold text-primary" : "text-muted-foreground"}`}><Bell className="h-[18px] w-[18px]" />提醒中心</Link>
    </nav>
    <div className="mt-auto pt-10">
      <div className="mb-5 rounded-2xl border border-primary/10 bg-gradient-to-br from-secondary to-transparent p-4"><span className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-card text-primary"><Cable className="h-4 w-4" /></span><p className="text-sm font-medium">协作，从连接开始</p><p className="mt-2 text-xs leading-5 text-muted-foreground">让熟悉的 agent，成为随手可及的工作伙伴。</p></div>
      <ConnectionGuide />
      <div className="mt-4 flex items-center gap-2 border-t px-3 pt-4 text-xs tracking-wide text-muted-foreground"><LockKeyhole className="h-3 w-3" />本机授权 · 远程协作</div>
    </div>
  </div>;
}
export function DashboardSidebar() {
  return <aside className="hidden w-60 shrink-0 border-r bg-card/70 p-5 lg:block"><DashboardNavigation /></aside>;
}
