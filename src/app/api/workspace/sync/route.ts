import { z } from "zod";
import { scheduleWorkspaceSync } from "@/lib/workspace/workspace-store";
import { startWorkspaceSync } from "@/lib/workspace/workspace-sync";
import { workspaceBody, workspaceUserId, workspaceJson, workspaceFailure } from "@/lib/workspace/workspace-http";
import { requirePolicyAcknowledgement, PolicyConsentRequiredError } from "@/lib/control/v2-policy";
import { ControlError } from "@/lib/control/control-transport";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const userId = await workspaceUserId();
    const parsed = z.object({ agentId: z.string().min(1).max(128).optional() }).strict().safeParse(await workspaceBody(request));
    if (!parsed.success) return workspaceJson({ error: "Invalid synchronization request" }, 400);
    try { await requirePolicyAcknowledgement(userId); }
    catch (error) { throw error instanceof PolicyConsentRequiredError
      ? new ControlError(error.message, 409) : new ControlError("无法验证平台当前政策，同步已暂停。", 503); }
    await scheduleWorkspaceSync(userId, parsed.data.agentId);
    startWorkspaceSync();
    return workspaceJson({ scheduled: true }, 202);
  } catch (error) { return workspaceFailure(error); }
}
