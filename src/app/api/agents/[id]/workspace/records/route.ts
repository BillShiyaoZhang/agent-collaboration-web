import { z } from "zod";
import { STABLE_ID_PATTERN } from "@agent-comm/client-contract";
import { getWorkspaceRecordStates, saveWorkspaceRecordState } from "@/lib/workspace/workspace-store";
import { workspaceBody, workspaceUserId, workspaceJson, workspaceFailure } from "@/lib/workspace/workspace-http";
export const dynamic = "force-dynamic";
const schema = z.object({ kind: z.enum(["contact", "collaboration"]), id: z.string().regex(new RegExp(STABLE_ID_PATTERN)), deleted: z.boolean() }).strict();
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params, userId = await workspaceUserId();
    return workspaceJson({ items: await getWorkspaceRecordStates(userId, id), scope: "account_view" });
  } catch (error) { return workspaceFailure(error); }
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params, userId = await workspaceUserId(), parsed = schema.safeParse(await workspaceBody(request));
    if (!parsed.success) return workspaceJson({ error: "Invalid account record state" }, 400);
    const value = parsed.data;
    return workspaceJson({ state: await saveWorkspaceRecordState(userId, id, value.kind, value.id, value.deleted), scope: "account_view" });
  } catch (error) { return workspaceFailure(error); }
}
