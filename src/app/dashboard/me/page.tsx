import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Footer } from "@/components/layout/footer";

export default function MePage() {
  return <div className="space-y-4"><h1 className="text-lg font-semibold">我</h1><section aria-label="账户设置" className="divide-y rounded-md border bg-card">{[
    { href: "/dashboard/settings", title: "邮箱与密码", text: "查看邮箱验证状态、验证邮箱与修改密码" },
    { href: "/dashboard/agents", title: "我的连接与访问", text: "管理连接名称、网页访问与连接设置" },
    { href: "/dashboard/notifications", title: "提醒与设备设置", text: "查看未读、待处理事项与系统提醒" },
    { href: "/docs/?path=deploy/users/README.md", title: "权限与数据说明", text: "查看配对、平台政策与账户副本的边界" },
  ].map(item => <Link key={item.href} href={item.href} className="flex items-center gap-3 p-3 hover:bg-muted"><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{item.title}</span><span className="mt-0.5 block text-xs text-muted-foreground">{item.text}</span></span><ChevronRight className="h-4 w-4 text-muted-foreground" /></Link>)}</section><details className="rounded-md border p-3"><summary className="cursor-pointer text-sm font-medium">数据与授权</summary><p className="mt-2 text-sm leading-6 text-muted-foreground">Web 保存获准读取的加密账户副本，托管服务可解密这些内容。删除网页连接会删除本账户对应副本，远端数据与本机配对仍保留。暂停网页控制、撤销本机配对与停止合规披露分别管理；已披露内容不能召回。</p></details><Footer /></div>;
}
