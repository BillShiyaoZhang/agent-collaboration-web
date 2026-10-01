import { listWorkspaceNodes } from "@/lib/workspace-nodes/gateway";
import { nodeFailure, nodeJson, nodePageQuery, workspaceNodeAccount } from "@/lib/workspace-nodes/http";

export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try { return nodeJson(await listWorkspaceNodes((await workspaceNodeAccount(request)).id, nodePageQuery(request))); }
  catch (error) { return nodeFailure(error); }
}
