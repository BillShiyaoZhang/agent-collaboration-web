import { getWorkspaceOverview } from "@/lib/workspace-store";
import { startWorkspaceSync } from "@/lib/workspace-sync";
import { workspaceUserId, workspaceJson, workspaceFailure } from "@/lib/workspace-http";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const result = await getWorkspaceOverview(await workspaceUserId());
    startWorkspaceSync();
    return workspaceJson(result);
  } catch (error) { return workspaceFailure(error); }
}
