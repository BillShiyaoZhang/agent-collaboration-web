import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";
import { generateURN } from "@/lib/crypto";
import crypto from "crypto";

const createAgentSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const agents = await prisma.agent.findMany({
      where: { userId: session.user.id },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(agents);
  } catch (error) {
    console.error("Error fetching agents:", error);
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
    const parsed = createAgentSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0].message },
        { status: 400 }
      );
    }

    const { name, password } = parsed.data;
    const urn = generateURN();

    // Generate Ed25519 key pair (in real implementation, would use proper crypto)
    // For now, we'll generate a mock key pair
    const publicKey = crypto.randomBytes(32).toString("hex");
    const privateKey = crypto.randomBytes(32).toString("hex");

    // Create agent in database
    const agent = await prisma.agent.create({
      data: {
        userId: session.user.id,
        name,
        urn,
        publicKey,
        encryptedPrivateKey: privateKey, // Would be encrypted with password in real impl
        keySalt: "salt", // Would be proper salt
        platformRegistered: false,
      },
    });

    return NextResponse.json(agent, { status: 201 });
  } catch (error) {
    console.error("Error creating agent:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}