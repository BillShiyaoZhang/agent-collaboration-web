"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut } from "next-auth/react";
import { ChevronDown, ChevronRight, LogOut, Menu, PanelLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DashboardNavigation } from "./dashboard-sidebar";

export function DashboardHeader({ user }: { user: { name?: string | null; email?: string | null } }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState("");
  async function logout() {
    setSigningOut(true); setError("");
    try { await signOut({ callbackUrl: "/login" }); }
    catch { setError("退出失败，请重试。"); setSigningOut(false); }
  }
  return <header className="relative z-20 flex h-16 shrink-0 items-center gap-3 border-b bg-card/75 px-4 backdrop-blur-xl sm:px-8">
    <Dialog open={menuOpen} onOpenChange={setMenuOpen}>
      <DialogTrigger asChild><Button variant="ghost" size="icon" className="-ml-2 lg:hidden" aria-label="打开导航"><Menu className="h-5 w-5" /></Button></DialogTrigger>
      <DialogContent className="left-0 top-0 h-full max-h-dvh w-[min(85vw,320px)] translate-x-0 translate-y-0 rounded-none p-6 sm:rounded-none data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-top-0 data-[state=closed]:slide-out-to-top-0 data-[state=open]:zoom-in-100 data-[state=closed]:zoom-out-100">
        <DialogTitle className="sr-only">工作空间导航</DialogTitle><DialogDescription className="sr-only">切换页面或查看连接指南。</DialogDescription><DashboardNavigation onNavigate={() => setMenuOpen(false)} />
      </DialogContent>
    </Dialog>
    <PanelLeft className="mr-2 hidden h-4 w-4 text-muted-foreground lg:block" aria-hidden="true" />
    <nav aria-label="面包屑" className="flex min-w-0 items-center gap-2 text-sm"><Link href="/dashboard/agents" className="whitespace-nowrap rounded-sm text-muted-foreground transition-colors hover:text-foreground" aria-current={pathname === "/dashboard/agents" ? "page" : undefined}>我的连接</Link>{pathname !== "/dashboard/agents" && <><ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="truncate font-medium" aria-current="page">工作台</span></>}</nav>
    <span className="flex-1" />
    {error && <span role="alert" className="text-xs text-destructive">{error}</span>}
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button variant="ghost" className="h-10 gap-2 rounded-full pl-1 pr-2" aria-label="账户菜单" disabled={signingOut}><span className="flex h-8 w-8 items-center justify-center rounded-full border bg-secondary text-xs font-semibold text-primary">{(user.name || user.email || "A").slice(0, 1).toUpperCase()}</span><span className="hidden max-w-32 truncate text-xs sm:block">{signingOut ? "正在退出…" : user.name || "我的账户"}</span><ChevronDown className="h-3.5 w-3.5 text-muted-foreground" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60 rounded-xl p-2"><DropdownMenuLabel className="font-normal"><span className="text-xs text-muted-foreground">当前账户</span><span className="mt-1 block break-all text-sm">{user.email}</span></DropdownMenuLabel><DropdownMenuSeparator /><DropdownMenuItem onSelect={logout} className="cursor-pointer gap-2 rounded-lg p-2.5"><LogOut className="h-4 w-4" />退出登录</DropdownMenuItem></DropdownMenuContent>
    </DropdownMenu>
  </header>;
}
