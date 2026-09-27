import { accountEmailPost, accountEmailFailure } from "@/lib/auth/account-email-http";
import { reportSubmitSchema, reportService } from "@/lib/moderation/report-service";
import { workspaceJson, workspaceUserId } from "@/lib/workspace/workspace-http";
export const runtime = "nodejs";
export async function POST(request: Request) { return accountEmailPost(request, reportSubmitSchema, (body,userId) => reportService.submit(userId!,body), { authenticated:true }); }
export async function GET(request: Request) {
  try { const limit = new URL(request.url).searchParams.get("limit"); if (limit !== null && !/^(?:[1-9]|[1-4][0-9]|50)$/.test(limit)) return workspaceJson({error:"Invalid limit"},400); return workspaceJson(await reportService.list(await workspaceUserId(),limit ? Number(limit):20)); }
  catch(error) { return accountEmailFailure(error); }
}
