import { getWorkspaceActivity } from "@/lib/product/workspace-activity";
import { workspaceFailure, workspaceJson, workspaceUserId } from "@/lib/workspace/workspace-http";
export const dynamic = "force-dynamic";
export async function GET() {
  try { return workspaceJson(await getWorkspaceActivity(await workspaceUserId())); }
  catch (error) { return workspaceFailure(error); }
}
