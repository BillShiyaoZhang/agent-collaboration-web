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
