import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";

export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { action } = body; // "approve" or "reject"

    if (!["approve", "reject"].includes(action)) {
      return NextResponse.json(
        { error: "Invalid action. Must be 'approve' or 'reject'" },
        { status: 400 }
      );
    }

    const hitlRequest = await prisma.hITLRequest.findFirst({
      where: {
        id: params.id,
        userId: session.user.id,
        status: "pending",
      },
    });

    if (!hitlRequest) {
      return NextResponse.json(
        { error: "HITL request not found or already resolved" },
        { status: 404 }
      );
    }

    const updatedRequest = await prisma.hITLRequest.update({
      where: { id: params.id },
      data: {
        status: action === "approve" ? "approved" : "rejected",
        resolvedAt: new Date(),
      },
    });

    // If approved, process the actual action (e.g., send message, execute transaction)
    if (action === "approve") {
      const payload = JSON.parse(hitlRequest.payload);

      switch (hitlRequest.requestType) {
        case "message":
          // Mark message as no longer pending - it would be sent here
          console.log("Approved message send:", payload);
          break;
        case "service_call":
          console.log("Approved service call:", payload);
          break;
        case "transaction":
          console.log("Approved transaction:", payload);
          break;
      }
    }

    return NextResponse.json(updatedRequest);
  } catch (error) {
    console.error("Error resolving HITL request:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}