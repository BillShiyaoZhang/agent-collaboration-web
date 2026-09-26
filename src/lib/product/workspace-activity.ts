import { getWorkspaceAgent, getWorkspaceOverview } from "@/lib/workspace/workspace-store";
import { activityItems, type AgentActivity } from "./activity-model";

export async function getWorkspaceActivity(userId: string): Promise<{ agents: AgentActivity[]; scope: "saved_account_history" }> {
  const overview = await getWorkspaceOverview(userId), agents: AgentActivity[] = [];
  // Read persisted account views only. Opening the hub never submits remote writes.
  for (const connection of overview.connections) {
    const workspace = await getWorkspaceAgent(userId, connection.id);
    if (workspace) agents.push({ workspace, items: activityItems(workspace) });
  }
  return { agents, scope: "saved_account_history" };
}
