import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";

const AGENT_PLATFORM_URL = process.env.AGENT_PLATFORM_URL || "http://localhost:8080";

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const query = searchParams.get("q");

    if (!query) {
      return NextResponse.json([]);
    }

    // Search via agent-comm-platform registry
    const response = await fetch(
      `${AGENT_PLATFORM_URL}/api/v1/registry/resolve?urn=${encodeURIComponent(query)}`,
      {
        method: "GET",
        headers: { "Content-Type": "application/json" },
      }
    );

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json([]);
      }
      throw new Error("Failed to search agents");
    }

    const data = await response.json();
    return NextResponse.json([data].flat());
  } catch (error) {
    console.error("Error searching agents:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}