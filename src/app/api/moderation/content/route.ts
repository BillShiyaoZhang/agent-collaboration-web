import {accountEmailPost,accountEmailFailure} from "@/lib/auth/account-email-http";
import {contentActionSchema,contentService} from "@/lib/moderation/content-service";
import {workspaceUserId,workspaceJson} from "@/lib/workspace/workspace-http";
export const runtime="nodejs";
export async function GET(request:Request) { try { const agentId=new URL(request.url).searchParams.get("agentId") || undefined;return workspaceJson(await contentService.list(await workspaceUserId(),agentId)); } catch(error) {return accountEmailFailure(error);} }
export async function POST(request:Request) { return accountEmailPost(request,contentActionSchema,(body,userId)=>contentService.action(userId!,body),{authenticated:true}); }
