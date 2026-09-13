import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import type { Prisma, User } from "@prisma/client";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";
import crypto from "crypto";
import { decryptPrivateKey } from "@/lib/crypto";
import { decodeEncryptedEnvelope, encodeEncryptedEnvelope, encodeChatMessage, decodeChatMessage } from "@/lib/proto";
import { signEnvelope, verifyEnvelope, verifyRegistration } from "@/lib/protocol-auth";
import { computeSharedSecret, encryptWithSharedSecret, decryptWithSharedSecret } from "@/lib/ecies";

const sendMessageSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  recipientUrn: z.string().min(1, "Recipient URN is required"),
  content: z.string().min(1, "Content is required"),
});

class PlatformError extends Error {}

async function platformFetch(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${process.env.AGENT_PLATFORM_URL || "http://localhost:8080"}${path}`, {
      ...init, cache: "no-store", signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new PlatformError("Cannot reach the Agent Platform. Please try again.");
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500).trim();
    throw new PlatformError(`Platform ${path.split("?")[0]} failed (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
  }
  return response;
}

function loadPrivateKey(user: User, encryptedJson: string): Buffer {
  const encrypted = JSON.parse(encryptedJson);
  const keyHex = decryptPrivateKey(
    encrypted.encrypted,
    process.env.NEXTAUTH_SECRET || "default_master_agent_secret_key_123!",
    encrypted.salt || user.virtualKeySalt || "", encrypted.iv, encrypted.authTag,
  );
  return Buffer.from(keyHex, "hex");
}

function loadSigningKey(user: User): crypto.KeyObject {
  return crypto.createPrivateKey({
    key: loadPrivateKey(user, user.virtualEd25519PrivateKey!), format: "der", type: "pkcs8",
  });
}

function loadEncryptionKey(user: User): Buffer {
  const key = loadPrivateKey(user, user.virtualX25519PrivateKey!);
  return key.length === 48 ? key.subarray(-32) : key;
}

function signedBodyHeaders(body: string, key: crypto.KeyObject, publicKey: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Ed25519 ${crypto.sign(null, Buffer.from(body, "utf8"), key).toString("hex")}:${publicKey}`,
  };
}

async function persistIncomingMessage(data: Prisma.MessageUncheckedCreateInput) {
  try {
    await prisma.message.create({ data });
  } catch (error) {
    // Stable primary keys make concurrent polls and failed ACK retries idempotent.
    if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
    const existing = await prisma.message.findUnique({ where: { id: data.id! } });
    if (!existing || existing.userId !== data.userId || existing.agentId !== data.agentId ||
        existing.senderUrn !== data.senderUrn || existing.recipientUrn !== data.recipientUrn ||
        existing.content !== data.content || !existing.isIncoming) {
      throw new Error("Incoming message ID conflicts with a stored message");
    }
  }
}

async function pollOwnerMessages(user: User) {
  if (!user.virtualUrn || !user.virtualEd25519PrivateKey || !user.virtualEd25519PublicKey ||
      !user.virtualX25519PrivateKey) return;
  const signingKey = loadSigningKey(user);
  const timestamp = Math.floor(Date.now() / 1000);
  const timestampBytes = Buffer.alloc(8);
  timestampBytes.writeBigInt64BE(BigInt(timestamp));
  const signature = crypto.sign(null, Buffer.concat([
    Buffer.from(`mq-retrieve|${user.virtualUrn}|`, "utf8"), timestampBytes,
  ]), signingKey);
  const response = await platformFetch("/api/v1/mq/retrieve", {
    headers: {
      "X-URN": user.virtualUrn, "X-Timestamp": String(timestamp),
      "X-Pubkey": user.virtualEd25519PublicKey, "X-Signature": signature.toString("hex"),
    },
  });
  const result = await response.json();
  if (!Array.isArray(result.messages)) throw new PlatformError("Platform returned an invalid mailbox response.");
  if (result.messages.length === 0) return;

  // A user's mailbox covers every bound agent. Route replies by authenticated
  // sender, never by the currently open agent tab.
  const agents = await prisma.agent.findMany({ where: { userId: user.id }, select: { id: true, urn: true } });
  const agentsByUrn = new Map(agents.map((agent) => [agent.urn, agent]));
  const encryptionKey = loadEncryptionKey(user);
  const messagesToAck: string[] = [];
  let rejectedMessages = 0;
  for (const item of result.messages) {
    let incoming: Prisma.MessageUncheckedCreateInput;
    let wireId: string;
    try {
      if (typeof item?.payload_proto !== "string" || typeof item?.message_id !== "string") throw new Error("Invalid mailbox item");
      const envelope = decodeEncryptedEnvelope(Buffer.from(item.payload_proto, "base64"));
      verifyEnvelope(envelope, user.virtualUrn);
      if (item.message_id !== envelope.messageId) throw new Error("Mailbox message ID does not match signed envelope");
      const agent = agentsByUrn.get(envelope.senderUrn);
      // Unbound senders are outside this console. Leave their messages pending.
      if (!agent) continue;
      const sharedSecret = computeSharedSecret(encryptionKey, envelope.senderStaticPubkey);
      const plaintext = decryptWithSharedSecret(sharedSecret, envelope.ephemeralPubkey, envelope.nonce, envelope.ciphertext, envelope.tag);
      const chatMessage = decodeChatMessage(plaintext);
      if (typeof chatMessage.text !== "string") throw new Error("Unsupported console message body");
      const createdAt = new Date(Number(chatMessage.timestamp || BigInt(Date.now())));
      if (Number.isNaN(createdAt.getTime())) throw new Error("Invalid message timestamp");
      wireId = envelope.messageId;
      const id = "mq-" + crypto.createHash("sha256").update(JSON.stringify([
        user.id, user.virtualUrn, envelope.senderUrn, wireId,
      ])).digest("hex");
      incoming = {
        id, userId: user.id, agentId: agent.id, senderUrn: envelope.senderUrn,
        recipientUrn: user.virtualUrn, content: chatMessage.text, isIncoming: true, createdAt,
      };
    } catch (error) {
      rejectedMessages++;
      console.error("Rejected incoming MQ message:", error instanceof Error ? error.message : "Invalid envelope");
      continue;
    }
    // A persistence failure leaves the message pending, without an ACK.
    await persistIncomingMessage(incoming);
    messagesToAck.push(wireId);
  }
  if (messagesToAck.length > 0) {
    const body = JSON.stringify({
      recipient_urn: user.virtualUrn, timestamp: Math.floor(Date.now() / 1000),
      message_ids: Array.from(new Set(messagesToAck)),
    });
    const ackResponse = await platformFetch("/api/v1/mq/ack", {
      method: "POST", headers: signedBodyHeaders(body, signingKey, user.virtualEd25519PublicKey), body,
    });
    const ack = await ackResponse.json();
    if (ack.ok !== true) throw new PlatformError("Platform did not acknowledge the received messages.");
  }
  if (rejectedMessages > 0) throw new PlatformError(`${rejectedMessages} incoming message(s) could not be verified or decoded and remain pending.`);
}

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const contactUrn = searchParams.get("contactUrn");
    const agentId = searchParams.get("agentId");
    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    let agentUrn = "";
    if (agentId) {
      const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: session.user.id } });
      if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
      agentUrn = agent.urn;
    }
    if (user) await pollOwnerMessages(user);
    let whereClause: Prisma.MessageWhereInput = { userId: session.user.id };
    if (contactUrn) {
      if (agentUrn && contactUrn === agentUrn && user?.virtualUrn) {
        whereClause = {
          userId: session.user.id, agentId: agentId || undefined,
          OR: [
            { senderUrn: user.virtualUrn, recipientUrn: agentUrn },
            { senderUrn: agentUrn, recipientUrn: user.virtualUrn },
          ],
        };
      } else {
        whereClause.recipientUrn = contactUrn;
        if (agentId) whereClause.agentId = agentId;
      }
    } else if (agentId) whereClause.agentId = agentId;
    const messages = await prisma.message.findMany({ where: whereClause, orderBy: { createdAt: "asc" }, take: 100 });
    return NextResponse.json(messages);
  } catch (error) {
    console.error("Error fetching messages:", error);
    return NextResponse.json(
      { error: error instanceof PlatformError ? error.message : "Internal server error" },
      { status: error instanceof PlatformError ? 502 : 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const parsed = sendMessageSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: parsed.error.errors[0].message }, { status: 400 });
    const { agentId, recipientUrn, content } = parsed.data;
    const agent = await prisma.agent.findFirst({ where: { id: agentId, userId: session.user.id } });
    if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
    if (recipientUrn === agent.urn) {
      if (!user.virtualUrn || !user.virtualEd25519PrivateKey || !user.virtualEd25519PublicKey ||
          !user.virtualX25519PrivateKey || !user.virtualX25519PublicKey) {
        return NextResponse.json({ error: "Virtual Console Identity not initialized. Please bind owner first." }, { status: 400 });
      }
      const resolveResponse = await platformFetch(`/api/v1/registry/resolve?urn=${encodeURIComponent(recipientUrn)}`);
      const record = await resolveResponse.json();
      let agentX25519PublicKey: Buffer;
      try {
        agentX25519PublicKey = Buffer.from(record.x25519_pubkey, "base64");
        verifyRegistration({
          urn: record.urn, peerId: record.peer_id, x25519Pubkey: agentX25519PublicKey,
          ed25519Pubkey: Buffer.from(record.ed25519_pubkey, "base64"),
          signature: Buffer.from(record.signature, "base64"),
          storesUserData: record.stores_user_data, timestamp: record.timestamp,
        }, recipientUrn);
      } catch {
        throw new PlatformError("The Platform returned an invalid signed identity for this agent.");
      }
      const signingKey = loadSigningKey(user);
      const sharedSecret = computeSharedSecret(loadEncryptionKey(user), agentX25519PublicKey);
      const conversationId = "web-console-" + crypto.createHash("sha256")
        .update(JSON.stringify([user.virtualUrn, recipientUrn])).digest("hex");
      const plaintext = encodeChatMessage(content, Date.now(), { conversationId, kind: "request" });
      const { ephemeral, nonce, ciphertext, tag } = encryptWithSharedSecret(sharedSecret, plaintext);
      const envelope = signEnvelope({
        senderUrn: user.virtualUrn, recipientUrn,
        senderStaticPubkey: Buffer.from(user.virtualX25519PublicKey, "hex"),
        ephemeralPubkey: ephemeral, nonce, ciphertext, tag, messageId: crypto.randomUUID(),
      }, signingKey);
      const body = JSON.stringify({
        recipient_urn: recipientUrn, expiry_unix: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        payload_proto: encodeEncryptedEnvelope(envelope).toString("base64"),
      });
      const storeResponse = await platformFetch("/api/v1/mq/store", {
        method: "POST", headers: signedBodyHeaders(body, signingKey, user.virtualEd25519PublicKey), body,
      });
      const stored = await storeResponse.json();
      if (stored.ok !== true || stored.message_id !== envelope.messageId) throw new PlatformError("Platform did not confirm storing the message.");
      const message = await prisma.message.create({
        data: { userId: session.user.id, agentId, senderUrn: user.virtualUrn, recipientUrn: agent.urn, content, isIncoming: false },
      });
      return NextResponse.json({ message }, { status: 201 });
    }
    // Agent-to-contact messages retain the existing approval flow.
    const message = await prisma.message.create({
      data: { userId: session.user.id, agentId, senderUrn: agent.urn, recipientUrn, content, isIncoming: false },
    });
    await prisma.contact.updateMany({ where: { agentId, contactUrn: recipientUrn }, data: { lastMessageAt: new Date() } });
    const hitlRequest = await prisma.hITLRequest.create({
      data: {
        userId: session.user.id, agentId, requestType: "message",
        payload: JSON.stringify({ messageId: message.id, recipientUrn, content }), status: "pending",
      },
    });
    return NextResponse.json({ message, hitlRequest }, { status: 201 });
  } catch (error) {
    console.error("Error sending message:", error);
    return NextResponse.json(
      { error: error instanceof PlatformError ? error.message : "Internal server error" },
      { status: error instanceof PlatformError ? 502 : 500 },
    );
  }
}
