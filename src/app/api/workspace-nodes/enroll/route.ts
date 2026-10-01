import { enrollWorkspaceNode } from "@/lib/workspace-nodes/gateway";
import { emptySchema, nodeBody, nodeFailure, nodeJson, workspaceNodeAccount } from "@/lib/workspace-nodes/http";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const account = await workspaceNodeAccount(request);
    if (!emptySchema.safeParse(await nodeBody(request)).success)
      return nodeJson({ error: "接入请求无效。" }, 400);
    return nodeJson(await enrollWorkspaceNode(account.id, account.label));
  } catch (error) { return nodeFailure(error); }
}
