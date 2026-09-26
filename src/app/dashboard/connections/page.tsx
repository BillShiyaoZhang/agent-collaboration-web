import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getWorkspaceAgent } from "@/lib/workspace/workspace-store";
import { workspaceUserId } from "@/lib/workspace/workspace-http";
import { RemoteWorkbench } from "@/components/remote-workbench";
export const dynamic = "force-dynamic";
export default async function ConnectionsPage({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const { agent } = await searchParams;
  if (!agent) redirect("/dashboard/agents");
  const workspace = await getWorkspaceAgent(await workspaceUserId(), agent);
  if (!workspace) notFound();
  return <div className="space-y-3"><header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-lg font-semibold">{workspace.agent.name} · 连接设置</h1><Link href="/dashboard/agents" className="text-sm text-primary underline underline-offset-4">管理所有连接</Link></header><RemoteWorkbench agent={workspace.agent} initial={workspace} scope="connection" /></div>;
}
