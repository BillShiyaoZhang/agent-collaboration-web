import { notFound } from "next/navigation";
import { WorkspaceHub } from "@/components/workspace-hub";
import { getWorkspaceActivity } from "@/lib/product/workspace-activity";
import { workspaceUserId } from "@/lib/workspace/workspace-http";
export const dynamic = "force-dynamic";
export default async function Page({ searchParams }: { searchParams: Promise<{ agent?: string }> }) {
  const initial = await getWorkspaceActivity(await workspaceUserId());
  const { agent } = await searchParams;
  if (agent && !initial.agents.some(value => value.workspace.agent.id === agent)) notFound();
  return <WorkspaceHub mode="contacts" initial={initial} />;
}
