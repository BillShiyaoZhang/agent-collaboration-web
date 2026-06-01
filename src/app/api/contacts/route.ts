import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";

const AGENT_PLATFORM_URL = process.env.AGENT_PLATFORM_URL || "http://localhost:8080";

const createContactSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  contactUrn: z.string().min(1, "Contact URN is required"),
  trustTier: z.enum(["family", "friend", "stranger", "self"]).default("stranger"),
  alias: z.string().optional(),
  publicKey: z.string().optional(),
});

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const contacts = await prisma.contact.findMany({
      where: { userId: session.user.id },
      include: {
        agent: {
          select: { id: true, name: true, urn: true },
        },
      },
      orderBy: [{ trustTier: "asc" }, { lastMessageAt: "desc" }],
    });

    return NextResponse.json(contacts);
  } catch (error) {
    console.error("Error fetching contacts:", error);
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
    const parsed = createContactSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0].message },
        { status: 400 }
      );
    }

    const { agentId, contactUrn, trustTier, alias, publicKey } = parsed.data;

    // Verify the agent belongs to the user
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, userId: session.user.id },
    });

    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Check if contact already exists
    const existingContact = await prisma.contact.findFirst({
      where: { agentId, contactUrn },
    });

    if (existingContact) {
      return NextResponse.json(
        { error: "Contact already exists" },
        { status: 409 }
      );
    }

    const contact = await prisma.contact.create({
      data: {
        userId: session.user.id,
        agentId,
        contactUrn,
        trustTier,
        alias,
        publicKey,
      },
    });

    return NextResponse.json(contact, { status: 201 });
  } catch (error) {
    console.error("Error creating contact:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}