import { accountEmailPost } from "@/lib/auth/account-email-http";
import { reportPreviewSchema, reportService } from "@/lib/moderation/report-service";
export const runtime = "nodejs";
export async function POST(request: Request) { return accountEmailPost(request, reportPreviewSchema, (body, userId) => reportService.preview(userId!,body), { authenticated:true }); }
