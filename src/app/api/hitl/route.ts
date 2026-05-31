import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const requests = await prisma.hITLRequest.findMany({
      where: { userId: session.user.id },
      include: {
        agent: {
          select: { id: true, name: true, urn: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(requests);
  } catch (error) {
    console.error("Error fetching HITL requests:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}