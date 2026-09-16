import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { prisma } from "@/lib/shared/db";
import { authOptions } from "@/lib/auth/auth";
import { resolveIdentity, ControlError } from "@/lib/control/control-transport";
import { requireSameOrigin } from "@/lib/control/control-protocol";
import { scheduleWorkspaceSync } from "@/lib/workspace/workspace-store";
import { startWorkspaceSync } from "@/lib/workspace/workspace-sync";
import { readJsonBody, RequestBodyError } from "@/lib/shared/http-input";

export async function GET() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({error:"Unauthorized"},{status:401});
  return NextResponse.json(await prisma.agent.findMany({where:{userId:session.user.id},orderBy:{createdAt:"desc"}}),{headers:{"Cache-Control":"no-store"}});
}
export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({error:"Unauthorized"},{status:401});
    try { requireSameOrigin(request); } catch { return NextResponse.json({error:"Forbidden origin"},{status:403}); }
    const parsed = z.object({name:z.string().trim().min(1).max(100),urn:z.string().min(10).max(256)}).strict().safeParse(await readJsonBody(request, 4096));
    if (!parsed.success) return NextResponse.json({error:"请填写连接名称与 agent 的完整 URN。"}, {status:400});
    const identity = await resolveIdentity(parsed.data.urn);
    const agent = await prisma.agent.create({data:{userId:session.user.id,name:parsed.data.name,urn:parsed.data.urn,publicKey:Buffer.from(identity.ed25519_pubkey,"base64").toString("hex"),platformRegistered:true}});
    await scheduleWorkspaceSync(session.user.id, agent.id);
    startWorkspaceSync();
    return NextResponse.json(agent,{status:201});
  } catch(error) {
    if (error instanceof RequestBodyError) return NextResponse.json({error:error.message},{status:error.status});
    if (error && typeof error === "object" && "code" in error && error.code === "P2002") return NextResponse.json({error:"该 agent 已保存连接。"}, {status:409});
    return NextResponse.json({error:error instanceof ControlError ? error.message : "无法保存连接。"}, {status:502});
  }
}
