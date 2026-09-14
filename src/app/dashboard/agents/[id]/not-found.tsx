import Link from "next/link";
import { Cable } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function ConnectionNotFound() {
  return <div className="surface mx-auto my-12 max-w-lg p-8 text-center"><Cable className="mx-auto mb-5 h-10 w-10 text-muted-foreground" /><h1 className="text-xl font-semibold">没有找到这个连接</h1><p className="mt-3 text-sm leading-6 text-muted-foreground">它可能已被移除，或不属于当前账户。</p><Button asChild className="mt-6"><Link href="/dashboard/agents">返回我的连接</Link></Button></div>;
}
