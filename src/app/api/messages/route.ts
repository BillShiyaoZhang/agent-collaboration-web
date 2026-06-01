import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";
import crypto from "crypto";
import { decryptPrivateKey } from "@/lib/crypto";
import { decodeEncryptedEnvelope, encodeEncryptedEnvelope, encodeChatMessage, decodeChatMessage } from "@/lib/proto";
import { computeSharedSecret, encryptWithSharedSecret, decryptWithSharedSecret } from "@/lib/ecies";

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

    // Fetch user and agent to check console polling conditions
    const user = await prisma.user.findUnique({ where: { id: session.user.id } });
    let agentUrn = "";
    if (agentId) {
      const agent = await prisma.agent.findFirst({
        where: { id: agentId, userId: session.user.id },
      });
      if (agent) {
        agentUrn = agent.urn;
      }
    }

    // Polling platform MQ for incoming owner commands/replies E2E
    if (user && user.virtualUrn && user.virtualEd25519PrivateKey && user.virtualX25519PrivateKey) {
      try {
        const masterKey = process.env.NEXTAUTH_SECRET || "default_master_agent_secret_key_123!";
        
        // Decrypt user Ed25519 private key
        const edEncrypted = JSON.parse(user.virtualEd25519PrivateKey);
        const edPrivKeyHex = decryptPrivateKey(
          edEncrypted.encrypted,
          masterKey,
          edEncrypted.salt || user.virtualKeySalt || "",
          edEncrypted.iv,
          edEncrypted.authTag
        );
        const edPrivKeyObj = crypto.createPrivateKey({
          key: Buffer.from(edPrivKeyHex, "hex"),
          format: "der",
          type: "pkcs8"
        });

        // Sign MQ retrieve request
        const timestamp = Math.floor(Date.now() / 1000);
        const tsBuf = Buffer.alloc(8);
        tsBuf.writeBigInt64BE(BigInt(timestamp));
        const signMsg = Buffer.concat([
          Buffer.from(`mq-retrieve|${user.virtualUrn}|`, "utf8"),
          tsBuf
        ]);
        const sig = crypto.sign(null, signMsg, edPrivKeyObj);

        // Retrieve from MQ platform
        const response = await fetch(`${process.env.AGENT_PLATFORM_URL || "http://localhost:8080"}/api/v1/mq/retrieve`, {
          method: "GET",
          headers: {
            "X-URN": user.virtualUrn,
            "X-Timestamp": String(timestamp),
            "X-Pubkey": user.virtualEd25519PublicKey || "",
            "X-Signature": sig.toString("hex"),
          }
        });

        if (response.ok) {
          const resData = await response.json();
          const messagesToAck: string[] = [];

          if (resData.messages && resData.messages.length > 0) {
            // Decrypt user X25519 private key
            const xEncrypted = JSON.parse(user.virtualX25519PrivateKey);
            const xPrivKeyHex = decryptPrivateKey(
              xEncrypted.encrypted,
              masterKey,
              xEncrypted.salt || user.virtualKeySalt || "",
              xEncrypted.iv,
              xEncrypted.authTag
            );
            let userX25519PrivKey = Buffer.from(xPrivKeyHex, "hex");
            if (userX25519PrivKey.length === 48) {
              userX25519PrivKey = userX25519PrivKey.subarray(-32);
            }

            for (const item of resData.messages) {
              try {
                const envelopeBuf = Buffer.from(item.payload_proto, "base64");
                const env = decodeEncryptedEnvelope(envelopeBuf);

                const sharedSecret = computeSharedSecret(userX25519PrivKey, env.senderStaticPubkey);
                const plaintext = decryptWithSharedSecret(sharedSecret, env.ephemeralPubkey, env.nonce, env.ciphertext, env.tag);
                const chatMsg = decodeChatMessage(plaintext);

                if (chatMsg.text) {
                  // Save message in DB
                  await prisma.message.create({
                    data: {
                      userId: session.user.id,
                      agentId: agentId || "",
                      senderUrn: env.senderUrn,
                      recipientUrn: user.virtualUrn,
                      content: chatMsg.text,
                      isIncoming: true,
                      createdAt: new Date(Number(chatMsg.timestamp || BigInt(Date.now()))),
                    }
                  });
                }
                messagesToAck.push(item.message_id);
              } catch (decErr) {
                console.error("Failed to decrypt MQ envelope:", decErr);
              }
            }

            // Ack retrieved messages
            if (messagesToAck.length > 0) {
              await fetch(`${process.env.AGENT_PLATFORM_URL || "http://localhost:8080"}/api/v1/mq/ack`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message_ids: messagesToAck }),
              });
            }
          }
        }
      } catch (err) {
        console.error("Failed to poll MQ messages during GET:", err);
      }
    }

    let whereClause: any = { userId: session.user.id };

    if (contactUrn) {
      if (agentUrn && contactUrn === agentUrn && user?.virtualUrn) {
        // Console mode: query messages between User and Agent
        whereClause = {
          userId: session.user.id,
          agentId: agentId || undefined,
          OR: [
            { senderUrn: user.virtualUrn, recipientUrn: agentUrn },
            { senderUrn: agentUrn, recipientUrn: user.virtualUrn },
          ],
        };
      } else {
        // Regular chat mode
        whereClause.recipientUrn = contactUrn;
        if (agentId) {
          whereClause.agentId = agentId;
        }
      }
    } else if (agentId) {
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

    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    // Direct owner console command execution (E2E chat console)
    if (recipientUrn === agent.urn) {
      if (!user.virtualUrn || !user.virtualEd25519PrivateKey || !user.virtualX25519PrivateKey) {
        return NextResponse.json({ error: "Virtual Console Identity not initialized. Please bind owner first." }, { status: 400 });
      }

      // 1. Resolve Agent public keys from Registry
      let agentX25519PubKeyHex = "";
      try {
        const resolveRes = await fetch(`${process.env.AGENT_PLATFORM_URL || "http://localhost:8080"}/api/v1/registry/resolve?urn=${encodeURIComponent(recipientUrn)}`);
        if (resolveRes.ok) {
          const resolveData = await resolveRes.json();
          if (resolveData.x25519_pubkey) {
            agentX25519PubKeyHex = Buffer.from(resolveData.x25519_pubkey, "base64").toString("hex");
          }
        }
      } catch (err) {
        console.error("Failed to resolve agent public key:", err);
      }

      if (!agentX25519PubKeyHex) {
        return NextResponse.json({ error: "Agent is not currently registered on the Platform. Please start the agent daemon." }, { status: 400 });
      }

      const masterKey = process.env.NEXTAUTH_SECRET || "default_master_agent_secret_key_123!";

      // 2. Load user virtual X25519 private key
      const xEncrypted = JSON.parse(user.virtualX25519PrivateKey);
      const xPrivKeyHex = decryptPrivateKey(
        xEncrypted.encrypted,
        masterKey,
        xEncrypted.salt || user.virtualKeySalt || "",
        xEncrypted.iv,
        xEncrypted.authTag
      );
      let userX25519PrivKey = Buffer.from(xPrivKeyHex, "hex");
      if (userX25519PrivKey.length === 48) {
        userX25519PrivKey = userX25519PrivKey.subarray(-32);
      }

      // 3. Encrypt payload
      const sharedSecret = computeSharedSecret(userX25519PrivKey, Buffer.from(agentX25519PubKeyHex, "hex"));
      const plaintextBuf = encodeChatMessage(content, Date.now());
      const { ephemeral, nonce, ciphertext, tag } = encryptWithSharedSecret(sharedSecret, plaintextBuf);

      const messageId = `msg-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
      const env = {
        senderUrn: user.virtualUrn,
        senderStaticPubkey: Buffer.from(user.virtualX25519PublicKey || "", "hex"),
        ephemeralPubkey: ephemeral,
        nonce,
        ciphertext,
        tag,
        messageId,
      };

      const envBytes = encodeEncryptedEnvelope(env);

      // 4. Store Envelope in Platform MQ
      const storeReqObj = {
        recipient_urn: recipientUrn,
        expiry_unix: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
        payload_proto: envBytes.toString("base64"),
      };
      const storeReqBytes = Buffer.from(JSON.stringify(storeReqObj), "utf8");

      // Sign the store request body using Ed25519
      const edEncrypted = JSON.parse(user.virtualEd25519PrivateKey);
      const edPrivKeyHex = decryptPrivateKey(
        edEncrypted.encrypted,
        masterKey,
        edEncrypted.salt || user.virtualKeySalt || "",
        edEncrypted.iv,
        edEncrypted.authTag
      );
      const edPrivKeyObj = crypto.createPrivateKey({
        key: Buffer.from(edPrivKeyHex, "hex"),
        format: "der",
        type: "pkcs8"
      });
      const bodySig = crypto.sign(null, storeReqBytes, edPrivKeyObj);

      const storeResponse = await fetch(`${process.env.AGENT_PLATFORM_URL || "http://localhost:8080"}/api/v1/mq/store`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Ed25519 ${bodySig.toString("hex")}:${user.virtualEd25519PublicKey}`,
        },
        body: storeReqBytes,
      });

      if (!storeResponse.ok) {
        const storeErr = await storeResponse.text();
        return NextResponse.json({ error: `MQ store failed: ${storeErr}` }, { status: 400 });
      }

      // Create message record locally (outgoing console command)
      const message = await prisma.message.create({
        data: {
          userId: session.user.id,
          agentId,
          senderUrn: user.virtualUrn,
          recipientUrn: agent.urn,
          content,
          isIncoming: false,
        },
      });

      return NextResponse.json({ message }, { status: 201 });
    }

    // --- Original Agent-to-Contact messaging flow ---
    // Create message record
    const message = await prisma.message.create({
      data: {
        userId: session.user.id,
        agentId,
        senderUrn: agent.urn,
        recipientUrn,
        content,
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