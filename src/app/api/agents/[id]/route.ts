import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/shared/db";
import { authOptions } from "@/lib/auth/auth";
export async function GET(request: Request, {params}: {params:Promise<{id:string}>}) {
  const { id } = await params;
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) return NextResponse.json({error:"Unauthorized"},{status:401});
  const agent = await prisma.agent.findFirst({where:{id,userId:session.user.id}});
  return NextResponse.json(agent || {error:"Connection not found"},{status:agent?200:404,headers:{"Cache-Control":"no-store"}});
}

import { z } from "zod";
import { renameWorkspaceAgent, removeWorkspaceAgent } from "@/lib/workspace/workspace-store";
import { workspaceBody, workspaceUserId, workspaceJson, workspaceFailure } from "@/lib/workspace/workspace-http";
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params, userId = await workspaceUserId();
    const parsed = z.object({ name: z.string().trim().min(1).max(120) }).strict().safeParse(await workspaceBody(request));
    if (!parsed.success) return workspaceJson({ error: "Invalid connection name" }, 400);
    return workspaceJson({ agent: await renameWorkspaceAgent(userId, id, parsed.data.name) });
  } catch (error) { return workspaceFailure(error); }
}
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params, userId = await workspaceUserId();
    if (!z.object({}).strict().safeParse(await workspaceBody(request)).success) return workspaceJson({ error: "Invalid connection removal" }, 400);
    await removeWorkspaceAgent(userId, id);
    return workspaceJson({ removed: true, scope: "account_connection" });
  } catch (error) { return workspaceFailure(error); }
}
