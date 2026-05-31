import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";

const createTransactionSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  fromUrn: z.string().min(1, "From URN is required"),
  toUrn: z.string().min(1, "To URN is required"),
  amount: z.string().min(1, "Amount is required"),
  currency: z.string().default("TOKEN"),
});

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const transactions = await prisma.transaction.findMany({
      where: { userId: session.user.id },
      include: {
        agent: {
          select: { id: true, name: true, urn: true },
        },
      },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json(transactions);
  } catch (error) {
    console.error("Error fetching transactions:", error);
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
    const parsed = createTransactionSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.errors[0].message },
        { status: 400 }
      );
    }

    const { agentId, fromUrn, toUrn, amount, currency } = parsed.data;

    // Verify agent belongs to user
    const agent = await prisma.agent.findFirst({
      where: { id: agentId, userId: session.user.id },
    });

    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Create transaction with pending status
    const transaction = await prisma.transaction.create({
      data: {
        userId: session.user.id,
        agentId,
        fromUrn,
        toUrn,
        amount,
        currency,
        status: "pending",
      },
    });

    // Create HITL request for transaction approval
    const hitlRequest = await prisma.hITLRequest.create({
      data: {
        userId: session.user.id,
        agentId,
        requestType: "transaction",
        payload: JSON.stringify({
          transactionId: transaction.id,
          fromUrn,
          toUrn,
          amount,
          currency,
        }),
        status: "pending",
      },
    });

    return NextResponse.json(
      { transaction, hitlRequest },
      { status: 201 }
    );
  } catch (error) {
    console.error("Error creating transaction:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}