import { redirect } from "next/navigation";
import { getWorkspaceOverview } from "@/lib/workspace/workspace-store";
import { workspaceUserId } from "@/lib/workspace/workspace-http";
export default async function DashboardPage() {
  const overview = await getWorkspaceOverview(await workspaceUserId());
  redirect(overview.connections.length === 1 ? `/dashboard/agents/${overview.connections[0].id}?tab=conversation` : "/dashboard/chats");
}
