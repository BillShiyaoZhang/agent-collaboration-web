"use client";
import Link from "next/link";
import { Unplug } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function DashboardError({ reset }: { reset: () => void }) {
  return <div className="surface mx-auto my-12 max-w-lg p-8 text-center"><Unplug className="mx-auto mb-5 h-10 w-10 text-muted-foreground" /><h1 className="text-xl font-semibold">工作空间暂时未能打开</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">请稍后重试，也可以先回到我的连接。</p><div className="mt-6 flex justify-center gap-3"><Button onClick={reset}>重新加载</Button><Button variant="outline" asChild><Link href="/dashboard/agents">返回我的连接</Link></Button></div></div>;
}
