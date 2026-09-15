import { z } from "zod";
import { ControlError } from "@/lib/control/control-transport";
import { workspaceBody, workspaceFailure, workspaceJson, workspaceUserId } from "@/lib/workspace/workspace-http";
import { getPushSettings, queuePushTest, recordPushReceipt, resolvePushDisplay, revokePushSubscription, savePushSubscription, updatePushPresence } from "@/lib/notifications/push-store";
import { pushSubscriptionSchema } from "@/lib/notifications/push-policy";
import { startPushWorker } from "@/lib/notifications/push-worker";
export const dynamic = "force-dynamic";
const deviceId = z.string().uuid(), deliveryId = z.string().regex(/^[a-f0-9-]{32,36}$/), binding = z.string().regex(/^[A-Za-z0-9_-]{32}$/);
const action = z.discriminatedUnion("action", [
  z.object({ action: z.literal("subscribe"), deviceId, subscription: pushSubscriptionSchema }).strict(),
  z.object({ action: z.literal("revoke"), deviceId }).strict(),
  z.object({ action: z.literal("presence"), deviceId, focused: z.boolean() }).strict(),
  z.object({ action: z.literal("test"), deviceId }).strict(),
  z.object({ action: z.literal("resolve"), deliveryId, binding }).strict(),
  z.object({ action: z.literal("receipt"), deliveryId, binding, status: z.enum(["displayed", "suppressed", "display_error", "deferred"]) }).strict(),
]);
export async function GET(request: Request) {
  try {
    const userId = await workspaceUserId(), query = new URL(request.url).searchParams, device = deviceId.safeParse(query.get("deviceId"));
    if (!device.success || Array.from(query.keys()).some(key => key !== "deviceId")) throw new ControlError("设备标识无效。", 400);
    startPushWorker(); return workspaceJson(await getPushSettings(userId, device.data));
  } catch (error) { return workspaceFailure(error); }
}
export async function POST(request: Request) {
  try {
    const userId = await workspaceUserId(), parsed = action.safeParse(await workspaceBody(request));
    if (!parsed.success) throw new ControlError("推送设置无效。", 400);
    const item = parsed.data; startPushWorker();
    if (item.action === "subscribe") return workspaceJson(await savePushSubscription(userId, item.deviceId, item.subscription));
    if (item.action === "resolve") return workspaceJson(await resolvePushDisplay(userId, item.deliveryId, item.binding));
    if (item.action === "test") return workspaceJson(await queuePushTest(userId, item.deviceId));
    if (item.action === "revoke") await revokePushSubscription(userId, item.deviceId);
    else if (item.action === "presence") await updatePushPresence(userId, item.deviceId, item.focused);
    else await recordPushReceipt(userId, item.deliveryId, item.binding, item.status);
    return workspaceJson({ saved: true });
  } catch (error) { return workspaceFailure(error); }
}
