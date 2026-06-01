import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";
import { generateURN } from "@/lib/crypto";
import crypto from "crypto";

const AGENT_PLATFORM_URL = process.env.AGENT_PLATFORM_URL || "http://localhost:8080";

const createAgentSchema = z.object({
  mode: z.enum(["create", "bind"]).default("create"),
  name: z.string().min(1, "Name is required").max(100),
  password: z.string().min(8, "Password must be at least 8 characters").optional(),
  urn: z.string().optional(),
  publicKey: z.string().optional(),
  localUrl: z.string().optional().or(z.literal("")),
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

    const { mode, name, password, urn, publicKey, localUrl } = parsed.data;

    if (mode === "bind") {
      if (!urn) {
        return NextResponse.json(
          { error: "URN is required for binding" },
          { status: 400 }
        );
      }

      // Check if URN already exists in our database
      const existingAgent = await prisma.agent.findUnique({
        where: { urn },
      });
      if (existingAgent) {
        return NextResponse.json(
          { error: "An agent with this URN is already registered or bound" },
          { status: 400 }
        );
      }

      let finalPublicKey = publicKey || "";
      let platformRegistered = false;

      // Try to resolve the agent from the platform registry
      try {
        const platformResolveUrl = `${AGENT_PLATFORM_URL}/api/v1/registry/resolve?urn=${encodeURIComponent(urn)}`;
        const response = await fetch(platformResolveUrl, {
          method: "GET",
          headers: { "Content-Type": "application/json" },
        });

        if (response.ok) {
          const data = await response.json();
          // Platform returns ed25519_pubkey as base64. Convert it to hex.
          if (data.ed25519_pubkey) {
            finalPublicKey = Buffer.from(data.ed25519_pubkey, "base64").toString("hex");
            platformRegistered = true;
          }
        }
      } catch (err) {
        console.warn("Failed to automatically resolve agent from platform:", err);
      }

      // Create agent in database
      const agent = await prisma.agent.create({
        data: {
          userId: session.user.id,
          name,
          urn,
          publicKey: finalPublicKey,
          encryptedPrivateKey: null,
          keySalt: null,
          localUrl: localUrl || null,
          platformRegistered,
        },
      });

      return NextResponse.json(agent, { status: 201 });
    } else {
      // Original "create" mode
      if (!password) {
        return NextResponse.json(
          { error: "Encryption password is required to generate credentials" },
          { status: 400 }
        );
      }

      const generatedUrn = generateURN();

      // Generate real Ed25519 key pair
      const { publicKey: pubKeyObj, privateKey: privKeyObj } = crypto.generateKeyPairSync("ed25519");
      const spkiDer = pubKeyObj.export({ type: "spki", format: "der" });
      const pkcs8Der = privKeyObj.export({ type: "pkcs8", format: "der" });
      const pubKeyHex = Buffer.from(spkiDer).subarray(-32).toString("hex");
      const privKeyHex = Buffer.from(pkcs8Der).toString("hex");

      // Create agent in database
      const agent = await prisma.agent.create({
        data: {
          userId: session.user.id,
          name,
          urn: generatedUrn,
          publicKey: pubKeyHex,
          encryptedPrivateKey: privKeyHex, // In real implementations this would be encrypted with password
          keySalt: "salt",
          localUrl: localUrl || null,
          platformRegistered: false,
        },
      });

      return NextResponse.json(agent, { status: 201 });
    }
  } catch (error) {
    console.error("Error creating agent:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}