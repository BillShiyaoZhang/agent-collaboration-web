import Link from "next/link";
export function DashboardSidebar() {
  return <aside className="hidden w-56 flex-col border-r bg-card p-6 md:flex">
    <Link href="/dashboard/agents" className="text-xl font-semibold">Agent Comm</Link>
    <p className="mt-2 text-sm text-muted-foreground">远程连接自己的 agent</p>
    <nav className="mt-8"><Link className="rounded-md bg-muted px-3 py-2 text-sm" href="/dashboard/agents">我的连接</Link></nav>
  </aside>;
}
