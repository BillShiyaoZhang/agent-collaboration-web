import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/shared/db";
import { authOptions } from "@/lib/auth/auth";
import { ControlError } from "@/lib/control/control-transport";
import { ensureConsoleIdentity } from "@/lib/control/console-identity";
import { requireSameOrigin } from "@/lib/control/control-protocol";
import { scheduleWorkspaceSync } from "@/lib/workspace/workspace-store";
import { startWorkspaceSync } from "@/lib/workspace/workspace-sync";
import { requirePolicyAcknowledgement, PolicyConsentRequiredError } from "@/lib/control/v2-policy";

function publicIdentity(user: {virtualUrn:string|null;virtualEd25519PublicKey:string|null;virtualX25519PublicKey:string|null}) {
  return {virtualUrn:user.virtualUrn,virtualEd25519PublicKey:user.virtualEd25519PublicKey,virtualX25519PublicKey:user.virtualX25519PublicKey};
}
async function owner(id:string) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new ControlError("Unauthorized",401);
  if (!await prisma.agent.findFirst({where:{id,userId:session.user.id}})) throw new ControlError("Connection not found",404);
  const user = await prisma.user.findUnique({where:{id:session.user.id}});
  if(!user) throw new ControlError("User not found",404);
  return user;
}
const failed = (error:unknown) => NextResponse.json({error:error instanceof ControlError?error.message:"无法创建控制台身份。"},
  {status:error instanceof ControlError?error.status:500});
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}) {
  try {return NextResponse.json(publicIdentity(await owner((await params).id)),{headers:{"Cache-Control":"no-store"}});} catch(error){return failed(error);}
}
export async function POST(request:Request,{params}:{params:Promise<{id:string}>}) {
  try {
    let user = await owner((await params).id);
    try {requireSameOrigin(request);} catch {throw new ControlError("Forbidden origin",403);}
    try { await requirePolicyAcknowledgement(user.id); }
    catch (error) { throw error instanceof PolicyConsentRequiredError
      ? new ControlError(error.message, 409) : new ControlError("无法验证平台当前政策，身份注册已暂停。", 503); }
    user = await ensureConsoleIdentity(user.id);
    await scheduleWorkspaceSync(user.id);
    startWorkspaceSync();
    return NextResponse.json({...publicIdentity(user),registered:true,
      note:"控制台身份已注册。请在 agent 本机配对该 URN，并将其加入 allow_from；保存 Web 连接本身不授予访问权。"});
  } catch(error){return failed(error);}
}
