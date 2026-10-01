import { claimWorkspaceNode } from "@/lib/workspace-nodes/gateway";
import { claimSchema, nodeBody, nodeFailure, nodeJson, workspaceNodeAccount } from "@/lib/workspace-nodes/http";

export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const account = await workspaceNodeAccount(request);
    const parsed = claimSchema.safeParse(await nodeBody(request));
    if (!parsed.success) return nodeJson({ error: "请输入有效的一次性连接码。" }, 400);
    return nodeJson(await claimWorkspaceNode(account.id, parsed.data.code, account.label));
  } catch (error) { return nodeFailure(error); }
}
