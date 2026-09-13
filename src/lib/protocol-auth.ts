import { createHash, createPrivateKey, createPublicKey, KeyObject, sign, verify } from "crypto";
import { EncryptedEnvelope, encodeEncryptedEnvelope } from "./proto";

const ENVELOPE_SIGNATURE_DOMAIN = Buffer.from("agent-comm-envelope-v1\0", "utf8");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58(bytes: Buffer): string {
  let value = bytes.length ? BigInt(`0x${bytes.toString("hex")}`) : BigInt(0);
  let encoded = "";
  while (value > BigInt(0)) {
    encoded = BASE58[Number(value % BigInt(58))] + encoded;
    value /= BigInt(58);
  }
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] !== 0) break;
    encoded = "1" + encoded;
  }
  return encoded;
}

function publicKey(raw: Buffer): KeyObject {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error("Ed25519 public key must be 32 bytes");
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), type: "spki", format: "der" });
}

export function urnMatchesPublicKey(urn: string, rawEd25519: Buffer): boolean {
  if (typeof urn !== "string" || !Buffer.isBuffer(rawEd25519) || rawEd25519.length !== 32 ||
      !urn.startsWith("urn:") || /[ \t\r\n|\0]/.test(urn)) return false;
  const separator = urn.lastIndexOf(":");
  if (separator <= 4 || separator === urn.length - 1) return false;
  return urn.slice(separator + 1) === base58(createHash("sha256").update(rawEd25519).digest().subarray(0, 16));
}

// Canonical libp2p PeerID: identity multihash of protobuf Ed25519 public key.
export function peerIdFromEd25519PublicKey(rawEd25519: Buffer): string {
  publicKey(rawEd25519);
  return base58(Buffer.concat([Buffer.from([0, 36, 8, 1, 18, 32]), rawEd25519]));
}

export function envelopeSigningBytes(env: EncryptedEnvelope): Buffer {
  return Buffer.concat([
    ENVELOPE_SIGNATURE_DOMAIN,
    encodeEncryptedEnvelope({ ...env, signature: Buffer.alloc(0) }),
  ]);
}

export type UnsignedEnvelope = Omit<EncryptedEnvelope, "senderEd25519Pubkey" | "signature"> &
  Partial<Pick<EncryptedEnvelope, "senderEd25519Pubkey" | "signature">>;

export function signEnvelope(env: UnsignedEnvelope, privateKey: KeyObject | string | Buffer): EncryptedEnvelope {
  const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
    throw new Error("An Ed25519 private key is required");
  }
  const raw = createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
  const signed: EncryptedEnvelope = { ...env, senderEd25519Pubkey: Buffer.from(raw), signature: Buffer.alloc(0) };
  if (!urnMatchesPublicKey(signed.senderUrn, signed.senderEd25519Pubkey)) {
    throw new Error("Envelope sender URN does not match signing key");
  }
  signed.signature = sign(null, envelopeSigningBytes(signed), key);
  verifyEnvelope(signed, signed.recipientUrn);
  return signed;
}

// Reject unsigned legacy traffic before decryption, persistence, or MQ ack.
export function verifyEnvelope(env: EncryptedEnvelope, expectedRecipientUrn: string): void {
  if (!env || !expectedRecipientUrn || env.recipientUrn !== expectedRecipientUrn) {
    throw new Error("Envelope recipient does not match destination");
  }
  if (!urnMatchesPublicKey(env.senderUrn, env.senderEd25519Pubkey)) {
    throw new Error("Envelope sender URN does not match signing key");
  }
  if (typeof env.messageId !== "string" || !env.messageId || Buffer.byteLength(env.messageId) > 256 || /[\0\r\n]/.test(env.messageId)) {
    throw new Error("Invalid envelope message ID");
  }
  for (const [field, length] of [["senderStaticPubkey", 32], ["ephemeralPubkey", 32], ["nonce", 12], ["tag", 16]] as const) {
    if (!Buffer.isBuffer(env[field]) || env[field].length !== length) throw new Error("Invalid envelope encryption field lengths");
  }
  if (!Buffer.isBuffer(env.signature) || env.signature.length !== 64) throw new Error("Missing or invalid envelope signature");
  encodeEncryptedEnvelope(env); // Apply the total size limit, including signature.
  if (!verify(null, envelopeSigningBytes(env), publicKey(env.senderEd25519Pubkey), env.signature)) {
    throw new Error("Invalid envelope signature");
  }
}

export interface RegistrationRecord {
  urn: string;
  peerId: string;
  x25519Pubkey: Buffer;
  ed25519Pubkey: Buffer;
  signature: Buffer;
  storesUserData: boolean;
  timestamp: number | bigint;
}

function registrationTimestamp(value: number | bigint): bigint {
  if ((typeof value !== "number" && typeof value !== "bigint") ||
      (typeof value === "number" && !Number.isSafeInteger(value))) throw new Error("Invalid registration timestamp");
  const timestamp = BigInt(value);
  if (timestamp <= BigInt(0) || timestamp > (BigInt(1) << BigInt(63)) - BigInt(1)) throw new Error("Invalid registration timestamp");
  return timestamp;
}

export function buildRegistrationSigningBytes(record: RegistrationRecord): Buffer {
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(registrationTimestamp(record.timestamp));
  return Buffer.concat([
    Buffer.from(`${record.urn}|${record.peerId}|${record.x25519Pubkey.toString("hex")}|${record.storesUserData ? "1" : "0"}|`, "utf8"),
    timestamp,
  ]);
}

// Persisted records remain authentic after the new-registration freshness
// window. Routing addresses are not covered by the Go registration signature.
export function verifyRegistration(record: RegistrationRecord, expectedUrn?: string): void {
  if (!record || (expectedUrn !== undefined && record.urn !== expectedUrn)) throw new Error("Registry URN does not match destination");
  if (!urnMatchesPublicKey(record.urn, record.ed25519Pubkey)) throw new Error("Registry identity key does not match URN");
  if (!Buffer.isBuffer(record.x25519Pubkey) || record.x25519Pubkey.length !== 32) throw new Error("Registry X25519 public key must be 32 bytes");
  if (record.peerId !== peerIdFromEd25519PublicKey(record.ed25519Pubkey)) throw new Error("Registry PeerID does not match identity key");
  if (typeof record.storesUserData !== "boolean") throw new Error("Invalid registry storage policy");
  if (!Buffer.isBuffer(record.signature) || record.signature.length !== 64) throw new Error("Registry signature must be 64 bytes");
  if (!verify(null, buildRegistrationSigningBytes(record), publicKey(record.ed25519Pubkey), record.signature)) {
    throw new Error("Invalid registry signature");
  }
}
