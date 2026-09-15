import crypto from "crypto";
import type { User } from "@prisma/client";
import { decryptPrivateKey } from "@/lib/protocol/crypto";
import { decodeEncryptedEnvelope, encodeEncryptedEnvelope, encodeChatMessage, decodeChatMessage } from "@/lib/protocol/proto";
import { signEnvelope, verifyEnvelope, verifyRegistration, peerIdFromEd25519PublicKey, buildRegistrationSigningBytes } from "@/lib/protocol/protocol-auth";
import { computeSharedSecret, encryptWithSharedSecret, decryptWithSharedSecret } from "@/lib/protocol/ecies";
import type { ControlRequestBody } from "@/lib/control/control-protocol";

export class ControlError extends Error {
  constructor(message: string, readonly status = 502) { super(message); }
}

export async function platformFetch(path: string, init?: RequestInit) {
  let response: Response;
  try {
    response = await fetch(`${process.env.AGENT_PLATFORM_URL || "http://localhost:8080"}${path}`, {
      ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
    });
  } catch { throw new ControlError("无法连接通信平台，请稍后重试同一请求。"); }
  if (!response.ok) throw new ControlError(`通信平台返回 HTTP ${response.status}。`);
  return response;
}

export function consoleKeys(user: User) {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new ControlError("服务器尚未配置 NEXTAUTH_SECRET。", 503);
  if (!user.virtualUrn || !user.virtualEd25519PublicKey || !user.virtualX25519PublicKey ||
      !user.virtualEd25519PrivateKey || !user.virtualX25519PrivateKey) throw new ControlError("请先建立控制台身份。", 409);
  const load = (value: string) => {
    const key = JSON.parse(value);
    return Buffer.from(decryptPrivateKey(key.encrypted, secret, key.salt || user.virtualKeySalt || "", key.iv, key.authTag), "hex");
  };
  return {
    urn: user.virtualUrn, publicKey: user.virtualEd25519PublicKey,
    xPublicKey: Buffer.from(user.virtualX25519PublicKey, "hex"),
    signingKey: crypto.createPrivateKey({ key: load(user.virtualEd25519PrivateKey), format: "der", type: "pkcs8" }),
    encryptionKey: load(user.virtualX25519PrivateKey).subarray(-32),
  };
}

export function signedHeaders(body: string, keys: ReturnType<typeof consoleKeys>) {
  return { "Content-Type": "application/json", Authorization: `Ed25519 ${crypto.sign(null, Buffer.from(body), keys.signingKey).toString("hex")}:${keys.publicKey}` };
}

export async function resolveIdentity(urn: string) {
  const data = await (await platformFetch(`/api/v1/registry/resolve?urn=${encodeURIComponent(urn)}`)).json();
  try {
    verifyRegistration({ urn: data.urn, peerId: data.peer_id,
      x25519Pubkey: Buffer.from(data.x25519_pubkey, "base64"), ed25519Pubkey: Buffer.from(data.ed25519_pubkey, "base64"),
      signature: Buffer.from(data.signature, "base64"), storesUserData: data.stores_user_data, timestamp: data.timestamp,
    }, urn);
  } catch { throw new ControlError("平台身份签名验证失败。"); }
  return data;
}

export async function registerConsole(user: User) {
  const keys = consoleKeys(user);
  const record = { urn: keys.urn, peerId: peerIdFromEd25519PublicKey(Buffer.from(keys.publicKey, "hex")),
    x25519Pubkey: keys.xPublicKey, ed25519Pubkey: Buffer.from(keys.publicKey, "hex"), signature: Buffer.alloc(0),
    storesUserData: true, timestamp: Math.floor(Date.now() / 1000) };
  record.signature = crypto.sign(null, buildRegistrationSigningBytes(record), keys.signingKey);
  const body = JSON.stringify({
    urn: record.urn, peer_id: record.peerId, x25519_pubkey: record.x25519Pubkey.toString("base64"),
    ed25519_pubkey: record.ed25519Pubkey.toString("base64"), signature: record.signature.toString("base64"),
    stores_user_data: true, timestamp: record.timestamp, addrs: [],
  });
  const response = await platformFetch("/api/v1/registry/register", { method: "POST", headers: signedHeaders(body, keys), body });
  await response.json();
}

export async function encodeControl(user: User, request: ControlRequestBody): Promise<string> {
  const keys = consoleKeys(user);
  const record = await resolveIdentity(request.agent_urn);
  const plaintext = encodeChatMessage(JSON.stringify(request), Date.now(), {
    conversationId: `control:${request.request_id}`, kind: "control.request", deadline: request.deadline,
  });
  const encrypted = encryptWithSharedSecret(computeSharedSecret(keys.encryptionKey, Buffer.from(record.x25519_pubkey, "base64")), plaintext);
  return encodeEncryptedEnvelope(signEnvelope({ senderUrn: keys.urn, recipientUrn: request.agent_urn,
    senderStaticPubkey: keys.xPublicKey, ephemeralPubkey: encrypted.ephemeral, nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext, tag: encrypted.tag, messageId: request.request_id,
  }, keys.signingKey)).toString("base64");
}

export function verifyConsoleEnvelope(user: User, encoded: string) {
  if (encoded.length > 1500000) throw new Error("Envelope too large");
  const envelope = decodeEncryptedEnvelope(Buffer.from(encoded, "base64"));
  if (!user.virtualUrn) throw new Error("Console identity missing");
  verifyEnvelope(envelope, user.virtualUrn);
  return envelope;
}

export function decodeControl(user: User, encoded: string, keys = consoleKeys(user)) {
  const envelope = verifyConsoleEnvelope(user, encoded);
  const plaintext = decryptWithSharedSecret(computeSharedSecret(keys.encryptionKey, envelope.senderStaticPubkey),
    envelope.ephemeralPubkey, envelope.nonce, envelope.ciphertext, envelope.tag);
  const chat = decodeChatMessage(plaintext);
  if (chat.kind !== "control.response" || !chat.text) throw new Error("Not a control response");
  return { envelope, chat, response: JSON.parse(chat.text) };
}

export async function submitEnvelope(user: User, envelope: string, recipientUrn: string, deadline: Date) {
  const keys = consoleKeys(user);
  const body = JSON.stringify({ recipient_urn: recipientUrn, expiry_unix: Math.ceil(deadline.getTime() / 1000), payload_proto: envelope });
  const result = await (await platformFetch("/api/v1/mq/store", { method: "POST", headers: signedHeaders(body, keys), body })).json();
  if (result.ok !== true || result.message_id !== decodeEncryptedEnvelope(Buffer.from(envelope, "base64")).messageId) throw new ControlError("平台未确认请求入队。");
}

export async function retrieveEnvelopes(user: User) {
  const keys = consoleKeys(user), timestamp = Math.floor(Date.now() / 1000), bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(BigInt(timestamp));
  const signature = crypto.sign(null, Buffer.concat([Buffer.from(`mq-retrieve|${keys.urn}|`), bytes]), keys.signingKey);
  const data = await (await platformFetch("/api/v1/mq/retrieve", { headers: {
    "X-URN": keys.urn, "X-Timestamp": String(timestamp), "X-Pubkey": keys.publicKey, "X-Signature": signature.toString("hex"),
  } })).json();
  if (!Array.isArray(data.messages)) throw new ControlError("平台返回了无效信箱数据。");
  return data.messages.slice(0, 100) as Array<{message_id: string; payload_proto: string}>;
}

export async function acknowledgeEnvelopes(user: User, messageIds: string[]) {
  if (!messageIds.length) return;
  const keys = consoleKeys(user);
  const body = JSON.stringify({ recipient_urn: keys.urn, timestamp: Math.floor(Date.now() / 1000), message_ids: Array.from(new Set(messageIds)) });
  const data = await (await platformFetch("/api/v1/mq/ack", { method: "POST", headers: signedHeaders(body, keys), body })).json();
  if (data.ok !== true) throw new ControlError("响应已保存，平台确认失败；可安全重试。");
}
