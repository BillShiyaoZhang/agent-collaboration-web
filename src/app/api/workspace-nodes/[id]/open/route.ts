import { launchWorkspaceNode } from "@/lib/workspace-nodes/gateway";
import { emptySchema, nodeBody, nodeFailure, nodeId, nodeJson, workspaceNodeAccount } from "@/lib/workspace-nodes/http";

export const dynamic = "force-dynamic";
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const account = await workspaceNodeAccount(request);
    if (!emptySchema.safeParse(await nodeBody(request)).success) return nodeJson({ error: "Invalid request" }, 400);
    return nodeJson(await launchWorkspaceNode(account.id, nodeId((await params).id)));
  } catch (error) { return nodeFailure(error); }
}
