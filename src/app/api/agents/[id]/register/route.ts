import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";
import * as crypto from "crypto";

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

    // Reconstruct the agent's private key keyobject
    const privateKeyObject = crypto.createPrivateKey({
      key: Buffer.from(agent.encryptedPrivateKey, "hex"),
      format: "der",
      type: "pkcs8",
    });

    const timestamp = Math.floor(Date.now() / 1000);
    const peerId = "12D3KooWKzoJzGnRpfd9ohJTYzGQbebi4rvRh1LWNnb4EaUBTThS"; // Valid peer ID

    // Message construction: urn + "|" + peerID + "|" + xHex + "|" + flag + "|" + BigEndianTimestamp
    const tsBuf = Buffer.alloc(8);
    tsBuf.writeBigInt64BE(BigInt(timestamp));

    const xHex = ""; // empty x25519 pubkey
    const flag = "0"; // storesUserData is false

    const messageStr = `${agent.urn}|${peerId}|${xHex}|${flag}|`;
    const messageBuffer = Buffer.concat([
      Buffer.from(messageStr, "utf8"),
      tsBuf
    ]);

    // Sign the registry message
    const registrySignature = crypto.sign(null, messageBuffer, privateKeyObject);

    // Construct request body
    const requestBodyObj = {
      urn: agent.urn,
      peer_id: peerId,
      addrs: [],
      relay_addrs: [],
      x25519_pubkey: Buffer.from([]).toString("base64"),
      ed25519_pubkey: Buffer.from(agent.publicKey, "hex").toString("base64"),
      stores_user_data: false,
      signature: registrySignature.toString("base64"),
      timestamp: timestamp
    };

    const requestBodyStr = JSON.stringify(requestBodyObj);

    // Sign the HTTP request body
    const httpSignature = crypto.sign(null, Buffer.from(requestBodyStr, "utf8"), privateKeyObject);
    const authHeader = `Ed25519 ${httpSignature.toString("hex")}:${agent.publicKey}`;

    // Register with agent-comm-platform
    const response = await fetch(`${AGENT_PLATFORM_URL}/api/v1/registry/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": authHeader,
      },
      body: requestBodyStr,
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