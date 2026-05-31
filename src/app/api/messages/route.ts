import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";

const sendMessageSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  recipientUrn: z.string().min(1, "Recipient URN is required"),
  content: z.string().min(1, "Content is required"),
});

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const contactUrn = searchParams.get("contactUrn");
    const agentId = searchParams.get("agentId");

    const whereClause: Record<string, unknown> = { userId: session.user.id };

    if (contactUrn) {
      whereClause.recipientUrn = contactUrn;
    }

    if (agentId) {
      whereClause.agentId = agentId;
    }

    const messages = await prisma.message.findMany({
      where: whereClause,
      orderBy: { createdAt: "asc" },
      take: 100,
    });

    return NextResponse.json(messages);
  } catch (error) {
    console.error("Error fetching messages:", error);
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
    const parsed = sendMessageSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0].message },
        { status: 400 }
      );
    }

    const { agentId, recipientUrn, content } = parsed.data;

    // Verify agent belongs to user
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, userId: session.user.id },
    });

    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Create message record
    const message = await prisma.message.create({
      data: {
        userId: session.user.id,
        agentId,
        senderUrn: agent.urn,
        recipientUrn,
        content, // Would be encrypted in real implementation
        isIncoming: false,
      },
    });

    // Update contact's last message time
    await prisma.contact.updateMany({
      where: {
        agentId,
        contactUrn: recipientUrn,
      },
      data: {
        lastMessageAt: new Date(),
      },
    });

    // Create HITL request for approval (since user > Agent, human must approve outgoing messages)
    const hitlRequest = await prisma.hITLRequest.create({
      data: {
        userId: session.user.id,
        agentId,
        requestType: "message",
        payload: JSON.stringify({
          messageId: message.id,
          recipientUrn,
          content,
        }),
        status: "pending",
      },
    });

    return NextResponse.json({ message, hitlRequest }, { status: 201 });
  } catch (error) {
    console.error("Error sending message:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}