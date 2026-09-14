import { z } from "zod";
import { getWorkspaceAgent, selectWorkspaceConversation, dismissWorkspaceSubmission } from "@/lib/workspace-store";
import { startWorkspaceSync } from "@/lib/workspace-sync";
import { workspaceBody, workspaceUserId, workspaceJson, workspaceFailure } from "@/lib/workspace-http";

export const dynamic = "force-dynamic";
import { STABLE_ID_PATTERN } from "@agent-comm/client-contract";
const idSchema = z.string().regex(new RegExp(STABLE_ID_PATTERN));

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await workspaceUserId();
    const search = new URL(request.url).searchParams;
    const conversationId = search.get("conversation_id") ?? undefined, before = search.get("before") ?? undefined;
    if ((conversationId && !idSchema.safeParse(conversationId).success) || (before && !idSchema.safeParse(before).success)) {
      return workspaceJson({ error: "Invalid conversation cursor" }, 400);
    }
    const result = await getWorkspaceAgent(userId, params.id, conversationId, before);
    if (!result) return workspaceJson({ error: "连接不存在。" }, 404);
    startWorkspaceSync();
    return workspaceJson(result);
  } catch (error) { return workspaceFailure(error); }
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  try {
    const userId = await workspaceUserId();
    const parsed = z.discriminatedUnion("action", [
      z.object({ action: z.literal("select_conversation"), conversationId: idSchema.nullable() }).strict(),
      z.object({ action: z.literal("dismiss_submission"), requestId: z.string().uuid() }).strict(),
    ]).safeParse(await workspaceBody(request));
    if (!parsed.success) return workspaceJson({ error: "Invalid workspace action" }, 400);
    if (parsed.data.action === "select_conversation") await selectWorkspaceConversation(userId, params.id, parsed.data.conversationId);
    else await dismissWorkspaceSubmission(userId, params.id, parsed.data.requestId);
    const result = await getWorkspaceAgent(userId, params.id);
    if (!result) return workspaceJson({ error: "连接不存在。" }, 404);
    return workspaceJson(result);
  } catch (error) { return workspaceFailure(error); }
}
