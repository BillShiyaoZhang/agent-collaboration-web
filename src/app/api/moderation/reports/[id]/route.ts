import { accountEmailFailure } from "@/lib/auth/account-email-http";
import { reportService } from "@/lib/moderation/report-service";
import { workspaceJson,workspaceUserId } from "@/lib/workspace/workspace-http";
export const runtime = "nodejs";
export async function GET(_request: Request,{params}:{params:Promise<{id:string}>}) { try { const {id}=await params; if(!/^[0-9a-f-]{36}$/i.test(id)) return workspaceJson({error:"Invalid report ID"},400); return workspaceJson(await reportService.get(await workspaceUserId(),id)); } catch(error) { return accountEmailFailure(error); } }
