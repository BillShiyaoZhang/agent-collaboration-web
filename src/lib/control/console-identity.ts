import crypto from "crypto";
import { prisma } from "@/lib/shared/db";
import { encryptPrivateKey, deriveUrnFromEd25519PubKey } from "@/lib/protocol/crypto";
import { registerConsole, ControlError } from "./control-transport";

/** Retry registration without rotating an account's existing identity. */
export async function ensureConsoleIdentity(userId: string) {
  let user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new ControlError("User not found", 404);
  const masterKey = process.env.NEXTAUTH_SECRET;
  if (!masterKey) throw new ControlError("服务器必须配置 NEXTAUTH_SECRET。", 503);
  if (!user.virtualUrn) {
    const ed = crypto.generateKeyPairSync("ed25519"), x = crypto.generateKeyPairSync("x25519");
    const edPublic = ed.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    const xPublic = x.publicKey.export({ type: "spki", format: "der" }).subarray(-32).toString("hex");
    const edSecret = encryptPrivateKey(ed.privateKey.export({ type: "pkcs8", format: "der" }).toString("hex"), masterKey);
    const xSecret = encryptPrivateKey(x.privateKey.export({ type: "pkcs8", format: "der" }).toString("hex"), masterKey);
    await prisma.user.updateMany({ where: { id: user.id, virtualUrn: null }, data: {
      virtualUrn: deriveUrnFromEd25519PubKey(edPublic), virtualEd25519PublicKey: edPublic, virtualX25519PublicKey: xPublic,
      virtualEd25519PrivateKey: JSON.stringify(edSecret), virtualX25519PrivateKey: JSON.stringify(xSecret), virtualKeySalt: edSecret.salt,
    } });
    user = (await prisma.user.findUnique({ where: { id: user.id } }))!;
  }
  await registerConsole(user);
  return user;
}
