import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";
import crypto from "crypto";
import { encryptPrivateKey, deriveUrnFromEd25519PubKey } from "@/lib/crypto";

export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Verify agent exists and belongs to user
    const agent = await prisma.agent.findFirst({
      where: {
        id: params.id,
        userId: session.user.id,
      },
    });

    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Fetch user to check if they already have a virtual identity
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    let virtualUrn = user.virtualUrn;
    let virtualEd25519PublicKey = user.virtualEd25519PublicKey;
    let virtualX25519PublicKey = user.virtualX25519PublicKey;

    if (!virtualUrn) {
      // Generate Ed25519 keypair
      const { publicKey: edPubKeyObj, privateKey: edPrivKeyObj } = crypto.generateKeyPairSync("ed25519");
      const edSpki = edPubKeyObj.export({ type: "spki", format: "der" });
      const edPkcs8 = edPrivKeyObj.export({ type: "pkcs8", format: "der" });
      const ed25519PubKeyHex = Buffer.from(edSpki).subarray(-32).toString("hex");
      const ed25519PrivKeyHex = Buffer.from(edPkcs8).toString("hex");

      // Generate user virtual URN derived from the public key
      virtualUrn = deriveUrnFromEd25519PubKey(ed25519PubKeyHex);

      // Generate X25519 keypair
      const { publicKey: xPubKeyObj, privateKey: xPrivKeyObj } = crypto.generateKeyPairSync("x25519");
      const xSpki = xPubKeyObj.export({ type: "spki", format: "der" });
      const xPkcs8 = xPrivKeyObj.export({ type: "pkcs8", format: "der" });
      const x25519PubKeyHex = Buffer.from(xSpki).subarray(-32).toString("hex");
      const x25519PrivKeyHex = Buffer.from(xPkcs8).toString("hex");

      // Master key derivation: use NextAuth secret or a fallback
      const masterKey = process.env.NEXTAUTH_SECRET || "default_master_agent_secret_key_123!";

      // Encrypt private keys
      const edEncrypted = encryptPrivateKey(ed25519PrivKeyHex, masterKey);
      const xEncrypted = encryptPrivateKey(x25519PrivKeyHex, masterKey);

      // Save to database
      await prisma.user.update({
        where: { id: user.id },
        data: {
          virtualUrn,
          virtualEd25519PublicKey: ed25519PubKeyHex,
          virtualEd25519PrivateKey: JSON.stringify({
            encrypted: edEncrypted.encrypted,
            iv: edEncrypted.iv,
            authTag: edEncrypted.authTag,
            salt: edEncrypted.salt,
          }),
          virtualX25519PublicKey: x25519PubKeyHex,
          virtualX25519PrivateKey: JSON.stringify({
            encrypted: xEncrypted.encrypted,
            iv: xEncrypted.iv,
            authTag: xEncrypted.authTag,
            salt: xEncrypted.salt,
          }),
          virtualKeySalt: edEncrypted.salt,
        },
      });

      virtualEd25519PublicKey = ed25519PubKeyHex;
      virtualX25519PublicKey = x25519PubKeyHex;
    }

    return NextResponse.json({
      virtualUrn,
      virtualEd25519PublicKey,
      virtualX25519PublicKey,
    });
  } catch (error) {
    console.error("Error in bind-owner route:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
