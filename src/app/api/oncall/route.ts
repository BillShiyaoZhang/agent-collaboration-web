import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";

const callServiceSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  targetUrn: z.string().min(1, "Target URN is required"),
  serviceName: z.string().min(1, "Service name is required"),
  args: z.record(z.unknown()).optional(),
});

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const targetUrn = searchParams.get("targetUrn");

    if (!targetUrn) {
      return NextResponse.json(
        { error: "Target URN is required" },
        { status: 400 }
      );
    }

    // Discover services from target agent via agent-oncall
    // In real implementation, this would call the agent-oncall Python script
    // For now, return mock service data
    const mockServices = [
      {
        name: "file.read",
        description: "Read a file from the agent's filesystem",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to read" },
          },
          required: ["path"],
        },
        requiresHitl: true,
        exposure: "Sd",
      },
      {
        name: "file.write",
        description: "Write content to a file",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string", description: "File path to write" },
            content: { type: "string", description: "Content to write" },
          },
          required: ["path", "content"],
        },
        requiresHitl: true,
        exposure: "So",
      },
    ];

    return NextResponse.json(mockServices);
  } catch (error) {
    console.error("Error discovering services:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const parsed = callServiceSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0].message },
        { status: 400 }
      );
    }

    const { agentId, targetUrn, serviceName, args } = parsed.data;

    // Verify agent belongs to user
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, userId: session.user.id },
    });

    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Create HITL request for service call
    const hitlRequest = await prisma.hITLRequest.create({
      data: {
        userId: session.user.id,
        agentId,
        requestType: "service_call",
        payload: JSON.stringify({
          targetUrn,
          serviceName,
          args,
        }),
        status: "pending",
      },
    });

    // In real implementation, would invoke agent-oncall here
    // For now, return the HITL request
    return NextResponse.json(
      {
        success: true,
        hitlRequest,
        message: "Service call requires HITL approval",
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error calling service:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}