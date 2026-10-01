import { listWorkspaceNodes } from "@/lib/workspace-nodes/gateway";
import { nodeFailure, nodeJson, workspaceNodeAccount } from "@/lib/workspace-nodes/http";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return nodeJson(await listWorkspaceNodes((await workspaceNodeAccount(request)).id)); }
  catch (error) { return nodeFailure(error); }
}
