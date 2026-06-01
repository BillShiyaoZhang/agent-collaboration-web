import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/db";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const userId = session.user.id;

    // Fetch stats for the user
    const [agentsCount, messagesCount, hitlCount, transactionsCount] = await Promise.all([
      prisma.agent.count({ where: { userId } }),
      prisma.message.count({ where: { userId } }),
      prisma.hITLRequest.count({ where: { userId } }),
      prisma.transaction.count({ where: { userId } }),
    ]);

    return NextResponse.json({
      user: {
        id: userId,
        email: session.user.email,
        name: session.user.name,
      },
      platform: {
        url: process.env.AGENT_PLATFORM_URL || "http://localhost:8080",
        databaseType: "SQLite",
        nodeEnv: process.env.NODE_ENV || "development",
        nextAuthUrl: process.env.NEXTAUTH_URL || "http://localhost:3000",
      },
      stats: {
        agents: agentsCount,
        messages: messagesCount,
        hitl: hitlCount,
        transactions: transactionsCount,
      },
    });
  } catch (error) {
    console.error("Error fetching settings:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
