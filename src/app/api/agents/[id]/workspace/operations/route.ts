import { z } from "zod";
import { controlCallSchema } from "@/lib/control/control-protocol";
import { getWorkspaceOperations, reserveWorkspaceOperation, updateWorkspaceOperation } from "@/lib/workspace/workspace-store";
import { workspaceBody, workspaceUserId, workspaceJson, workspaceFailure } from "@/lib/workspace/workspace-http";
import { STABLE_ID_PATTERN } from "@agent-comm/client-contract";

export const dynamic = "force-dynamic";
const stableId = z.string().regex(new RegExp(STABLE_ID_PATTERN));
const mutationMethods = new Set(["contacts.add", "approval.respond", "contacts.respond", "messages.send", "inbox.mark_read", "collaboration.execute"]);
const bodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("import_legacy"), call: controlCallSchema, reusedContact: z.boolean().optional() }).strict(),
  z.object({ action: z.literal("reserve"), call: controlCallSchema, reusedContact: z.boolean().optional(), conversationId: stableId.optional() }).strict(),
  // Results cannot be written by browsers. A success hint does not settle the operation.
  z.object({ action: z.literal("update"), requestId: z.string().uuid(), phase: z.enum(["sending", "uncertain", "failed", "succeeded"]), message: z.string().max(2000).optional(), retryable: z.boolean().optional() }).strict(),
]);
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params, userId = await workspaceUserId();
    return workspaceJson({ items: await getWorkspaceOperations(userId, id) });
  } catch (error) { return workspaceFailure(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params, userId = await workspaceUserId(), parsed = bodySchema.safeParse(await workspaceBody(request, 32768));
    if (!parsed.success || parsed.data.action !== "update" && (!mutationMethods.has(parsed.data.call.method) || parsed.data.call.method === "collaboration.execute" && parsed.data.call.params.action === "describe")) return workspaceJson({ error: "Invalid operation record" }, 400);
    const value = parsed.data;
    const item = value.action !== "update" ? await reserveWorkspaceOperation(userId, id, value.call, { reusedContact: value.reusedContact, conversationId: value.action === "reserve" ? value.conversationId : undefined, legacy: value.action === "import_legacy" })
      : await updateWorkspaceOperation(userId, id, value.requestId, { phase: value.phase, message: value.message, retryable: value.retryable });
    return workspaceJson({ item });
  } catch (error) { return workspaceFailure(error); }
}
