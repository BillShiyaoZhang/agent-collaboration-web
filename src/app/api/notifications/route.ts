import { z } from "zod";
import { getWorkspaceNotifications, readWorkspaceNotification, claimWorkspaceNotification } from "@/lib/workspace/workspace-store";
import { workspaceUserId, workspaceJson, workspaceFailure, workspaceBody } from "@/lib/workspace/workspace-http";
import { ControlError } from "@/lib/control/control-transport";

export const dynamic = "force-dynamic";
const identity = { agentId: z.string().min(1).max(128), id: z.string().regex(/^[a-f0-9]{64}$/), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) };
const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("read"), ...identity }).strict(),
  z.object({ action: z.literal("claim"), ...identity, deviceId: z.string().uuid() }).strict(),
]);
export async function GET(request: Request) {
  try {
    const userId = await workspaceUserId(), query = new URL(request.url).searchParams;
    const before = query.has("before") ? Number(query.get("before")) : undefined;
    const filter = query.get("filter") || "all";
    if (Array.from(query.keys()).some(key => !["before", "filter"].includes(key)) || before !== undefined && (!Number.isSafeInteger(before) || before <= 0) || !["all", "unread", "pending"].includes(filter)) throw new ControlError("提醒查询无效。", 400);
    return workspaceJson(await getWorkspaceNotifications(userId, before, filter as "all" | "unread" | "pending"));
  } catch (error) { return workspaceFailure(error); }
}
export async function POST(request: Request) {
  try {
    const userId = await workspaceUserId(), body = action.safeParse(await workspaceBody(request));
    if (!body.success) throw new ControlError("提醒操作无效。", 400);
    const item = body.data;
    if (item.action === "claim") return workspaceJson({ claimed: await claimWorkspaceNotification(userId, item.agentId, item.id, item.revision, item.deviceId) });
    await readWorkspaceNotification(userId, item.agentId, item.id, item.revision);
    return workspaceJson({ saved: true });
  } catch (error) { return workspaceFailure(error); }
}
