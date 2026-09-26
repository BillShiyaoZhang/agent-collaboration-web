import { z } from "zod";
import { listWorkspaceConversations, saveWorkspaceConversationState } from "@/lib/workspace/workspace-store";
import { workspaceBody, workspaceUserId, workspaceJson, workspaceFailure } from "@/lib/workspace/workspace-http";
import { STABLE_ID_PATTERN, MAX_CONVERSATION_BYTES } from "@agent-comm/client-contract";

export const dynamic = "force-dynamic";
const stableId = z.string().regex(new RegExp(STABLE_ID_PATTERN));
const bodySchema = z.object({ conversationId: stableId.nullable(), title: z.string().trim().min(1).max(120).optional(), archived: z.boolean().optional(),
  readAt: z.number().finite().nonnegative().optional(), draft: z.string().refine(value => new TextEncoder().encode(value).length <= MAX_CONVERSATION_BYTES).optional(),
  scrollTop: z.number().finite().nonnegative().max(100000000).nullable().optional() }).strict();
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params, userId = await workspaceUserId(), search = new URL(request.url).searchParams;
    const parsed = z.object({ q: z.string().max(200).optional(), archived: z.enum(["active", "archived", "all"]).optional(), before: stableId.optional(), limit: z.coerce.number().int().min(1).max(50).optional() })
      .safeParse(Object.fromEntries(search));
    if (!parsed.success) return workspaceJson({ error: "Invalid saved conversation query" }, 400);
    return workspaceJson(await listWorkspaceConversations(userId, id, parsed.data));
  } catch (error) { return workspaceFailure(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params, userId = await workspaceUserId(), parsed = bodySchema.safeParse(await workspaceBody(request, 32768));
    if (!parsed.success) return workspaceJson({ error: "Invalid saved conversation state" }, 400);
    const { conversationId, ...patch } = parsed.data;
    return workspaceJson({ state: await saveWorkspaceConversationState(userId, id, conversationId, patch) });
  } catch (error) { return workspaceFailure(error); }
}
