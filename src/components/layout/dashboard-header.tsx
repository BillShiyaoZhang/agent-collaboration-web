"use client";
import Link from "next/link";
import {signOut} from "next-auth/react";
import {Button} from "@/components/ui/button";
export function DashboardHeader({user}:{user:{name?:string|null;email?:string|null}}){
  return <header className="flex h-14 items-center gap-4 border-b px-6">
    <Link href="/dashboard/agents" className="text-sm">我的连接</Link>
    <span className="flex-1"/><span className="text-sm text-muted-foreground">{user.email}</span>
    <Button variant="ghost" onClick={()=>signOut({callbackUrl:"/login"})}>退出</Button>
  </header>;
}
