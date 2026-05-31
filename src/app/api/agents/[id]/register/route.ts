import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";

const AGENT_PLATFORM_URL = process.env.AGENT_PLATFORM_URL || "http://localhost:8080";

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const agent = await prisma.agent.findFirst({
      where: {
        id: params.id,
        userId: session.user.id,
      },
    });

    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Register with agent-comm-platform
    const response = await fetch(`${AGENT_PLATFORM_URL}/api/v1/registry/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        urn: agent.urn,
        public_key: agent.publicKey,
        timestamp: Date.now(),
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      return NextResponse.json(
        { error: `Failed to register agent: ${error}` },
        { status: response.status }
      );
    }

    // Update agent as registered
    const updatedAgent = await prisma.agent.update({
      where: { id: agent.id },
      data: { platformRegistered: true },
    });

    return NextResponse.json(updatedAgent);
  } catch (error) {
    console.error("Error registering agent:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}