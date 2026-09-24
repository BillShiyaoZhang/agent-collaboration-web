import crypto from "crypto";
import { encodeV2Header, signV2Envelope, type V2Envelope, type V2Header, type V2Policy, type V2Slot,
  V2_AGENT_CONTENT_TYPE, v2Hash } from "@/lib/protocol/v2";

const X25519_PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const X25519_SPKI = Buffer.from("302a300506032b656e032100", "hex");
const KEM_SUITE = Buffer.from([0x4b, 0x45, 0x4d, 0x00, 0x20]);
const HPKE_SUITE = Buffer.from([0x48, 0x50, 0x4b, 0x45, 0x00, 0x20, 0x00, 0x01, 0x00, 0x02]);

function hash(bytes: Buffer): Buffer { return crypto.createHash("sha256").update(bytes).digest(); }
function hkdfExtract(salt: Buffer, ikm: Buffer): Buffer {
  return crypto.createHmac("sha256", salt.length ? salt : Buffer.alloc(32)).update(ikm).digest();
}
function hkdfExpand(prk: Buffer, info: Buffer, length: number): Buffer {
  if (length < 0 || length > 255 * 32) throw new Error("Invalid HPKE HKDF length");
  const blocks: Buffer[] = []; let previous = Buffer.alloc(0);
  for (let count = 1; Buffer.concat(blocks).length < length; count++) {
    previous = crypto.createHmac("sha256", prk).update(previous).update(info).update(Buffer.from([count])).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}
function labeledExtract(salt: Buffer, suite: Buffer, label: string, ikm: Buffer): Buffer {
  return hkdfExtract(salt, Buffer.concat([Buffer.from("HPKE-v1"), suite, Buffer.from(label), ikm]));
}
function labeledExpand(prk: Buffer, suite: Buffer, label: string, info: Buffer, length: number): Buffer {
  const size = Buffer.alloc(2); size.writeUInt16BE(length);
  return hkdfExpand(prk, Buffer.concat([size, Buffer.from("HPKE-v1"), suite, Buffer.from(label), info]), length);
}
function xPrivate(raw: Buffer): crypto.KeyObject {
  if (raw.length !== 32) throw new Error("Invalid X25519 private key");
  return crypto.createPrivateKey({ key: Buffer.concat([X25519_PKCS8, raw]), type: "pkcs8", format: "der" });
}
function xPublic(raw: Buffer): crypto.KeyObject {
  if (raw.length !== 32) throw new Error("Invalid X25519 public key");
  return crypto.createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), type: "spki", format: "der" });
}
function xPublicRaw(privateKey: crypto.KeyObject): Buffer {
  return crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32);
}
function shared(privateKey: crypto.KeyObject, peer: Buffer, enc: Buffer, recipientPublic: Buffer): Buffer {
  const dh = crypto.diffieHellman({ privateKey, publicKey: xPublic(peer) });
  if (dh.equals(Buffer.alloc(32))) throw new Error("Invalid HPKE X25519 shared secret");
  const eaePRK = labeledExtract(Buffer.alloc(0), KEM_SUITE, "eae_prk", dh);
  return labeledExpand(eaePRK, KEM_SUITE, "shared_secret", Buffer.concat([enc, recipientPublic]), 32);
}
function hpkeKeyNonce(secret: Buffer, info: Buffer): { key: Buffer; nonce: Buffer } {
  const pskIDHash = labeledExtract(Buffer.alloc(0), HPKE_SUITE, "psk_id_hash", Buffer.alloc(0));
  const infoHash = labeledExtract(Buffer.alloc(0), HPKE_SUITE, "info_hash", info);
  const context = Buffer.concat([Buffer.from([0]), pskIDHash, infoHash]);
  const prk = labeledExtract(secret, HPKE_SUITE, "secret", Buffer.alloc(0));
  return { key: labeledExpand(prk, HPKE_SUITE, "key", context, 32),
    nonce: labeledExpand(prk, HPKE_SUITE, "base_nonce", context, 12) };
}
function aesSeal(key: Buffer, nonce: Buffer, plaintext: Buffer, aad: Buffer): Buffer {
  if (key.length !== 32 || nonce.length !== 12) throw new Error("Invalid AES-GCM key or nonce");
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(aad);
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
function aesOpen(key: Buffer, nonce: Buffer, ciphertext: Buffer, aad: Buffer): Buffer {
  if (key.length !== 32 || nonce.length !== 12 || ciphertext.length < 16) throw new Error("Invalid AES-GCM fields");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(aad); decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
}

/** RFC 9180 Base mode, X25519 / HKDF-SHA256 / AES-256-GCM, sequence zero. */
export function hpkeSeal(recipientPublic: Buffer, plaintext: Buffer, info: Buffer, aad: Buffer): { enc: Buffer; ciphertext: Buffer } {
  if (recipientPublic.length !== 32) throw new Error("Invalid HPKE recipient key");
  const ephemeral = crypto.generateKeyPairSync("x25519").privateKey;
  const enc = xPublicRaw(ephemeral);
  const secret = shared(ephemeral, recipientPublic, enc, recipientPublic);
  const { key, nonce } = hpkeKeyNonce(secret, info);
  return { enc, ciphertext: aesSeal(key, nonce, plaintext, aad) };
}

export function hpkeOpen(recipientPrivate: Buffer, enc: Buffer, ciphertext: Buffer, info: Buffer, aad: Buffer): Buffer {
  if (enc.length !== 32 || ciphertext.length < 16) throw new Error("Invalid HPKE slot");
  const privateKey = xPrivate(recipientPrivate), recipientPublic = xPublicRaw(privateKey);
  const secret = shared(privateKey, enc, enc, recipientPublic);
  const { key, nonce } = hpkeKeyNonce(secret, info);
  return aesOpen(key, nonce, ciphertext, aad);
}

export function v2BodyAAD(header: V2Header): Buffer {
  return Buffer.concat([Buffer.from("agent-comm-v2-body\0"), hash(encodeV2Header(header))]);
}
export function v2SlotContext(header: V2Header, bodyCiphertext: Buffer, role: string, keyID: string): Buffer {
  if (!role || !keyID) throw new Error("Invalid v2 slot role or key ID");
  return Buffer.concat([Buffer.from("agent-comm-v2-hpke\0"), hash(v2BodyAAD(header)), hash(bodyCiphertext),
    Buffer.from(role), Buffer.from([0]), Buffer.from(keyID)]);
}
function sealSlot(header: V2Header, bodyCiphertext: Buffer, cek: Buffer, recipientPublic: Buffer, role: string, keyID: string): V2Slot {
  const context = v2SlotContext(header, bodyCiphertext, role, keyID);
  const sealed = hpkeSeal(recipientPublic, cek, context, context);
  return { role, key_id: keyID, enc: sealed.enc.toString("base64"), ciphertext: sealed.ciphertext.toString("base64") };
}
function openSlot(header: V2Header, bodyCiphertext: Buffer, slot: V2Slot, recipientPrivate: Buffer): Buffer {
  const context = v2SlotContext(header, bodyCiphertext, slot.role, slot.key_id);
  if (!slot.enc || !slot.ciphertext) throw new Error("Incomplete v2 HPKE slot");
  return hpkeOpen(recipientPrivate, Buffer.from(slot.enc, "base64"), Buffer.from(slot.ciphertext, "base64"), context, context);
}

export function sealV2Compliance(policy: V2Policy, policyRaw: Buffer, header: V2Header, plaintext: Buffer,
  recipientPublic: Buffer, senderPrivate: crypto.KeyObject): { envelope: Buffer; cek: Buffer } {
  if (policy.mode !== "compliance" || header.mode !== "compliance" || header.platform_id !== policy.platform_id ||
      header.policy_epoch !== policy.epoch || header.policy_hash !== v2Hash(policyRaw) ||
      header.suite !== policy.suite || header.content_type !== V2_AGENT_CONTENT_TYPE ||
      !policy.gateway_public_key || !policy.gateway_key_id || recipientPublic.length !== 32)
    throw new Error("Invalid v2 compliance policy or header");
  const fullHeader = { ...header, gateway_key_id: policy.gateway_key_id, slot_roles: ["recipient", "gateway"] };
  const cek = crypto.randomBytes(32), nonce = crypto.randomBytes(12);
  const ciphertext = aesSeal(cek, nonce, plaintext, v2BodyAAD(fullHeader));
  const slots = [sealSlot(fullHeader, ciphertext, cek, recipientPublic, "recipient", fullHeader.recipient_key_id),
    sealSlot(fullHeader, ciphertext, cek, Buffer.from(policy.gateway_public_key, "base64"), "gateway", policy.gateway_key_id)];
  return { envelope: signV2Envelope({ header: fullHeader, nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"), slots }, senderPrivate), cek };
}

export function openV2ComplianceRecipient(env: V2Envelope, recipientPrivate: Buffer): { cek: Buffer; plaintext: Buffer } {
  if (env.header.mode !== "compliance" || env.slots.length !== 2 || env.slots[0].role !== "recipient" ||
      env.slots[1].role !== "gateway" || !env.nonce || !env.ciphertext) throw new Error("Invalid v2 compliance envelope");
  const ciphertext = Buffer.from(env.ciphertext, "base64");
  const cek = openSlot(env.header, ciphertext, env.slots[0], recipientPrivate);
  if (cek.length !== 32) throw new Error("Invalid v2 CEK length");
  return { cek, plaintext: aesOpen(cek, Buffer.from(env.nonce, "base64"), ciphertext, v2BodyAAD(env.header)) };
}

export function openV2Private(env: V2Envelope, messageKey: Buffer): Buffer {
  if (env.header.mode !== "private" || env.slots.length !== 0 || !env.nonce || !env.ciphertext)
    throw new Error("Invalid v2 private envelope");
  return aesOpen(messageKey, Buffer.from(env.nonce, "base64"), Buffer.from(env.ciphertext, "base64"), v2BodyAAD(env.header));
}
