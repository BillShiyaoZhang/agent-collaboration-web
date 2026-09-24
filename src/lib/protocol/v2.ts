import crypto from "crypto";
import { urnMatchesPublicKey } from "@/lib/protocol/protocol-auth";

// The v2 wire is Go encoding/json of fixed structs, with SetEscapeHTML(false).
// Re-encoding before verification rejects duplicate/unknown keys and alternate
// spellings of signed values instead of trusting JSON.parse's last-key-wins rule.
const DOMAIN = {
  policy: Buffer.from("agent-comm-v2-policy\0"),
  envelope: Buffer.from("agent-comm-v2-envelope\0"),
  receipt: Buffer.from("agent-comm-v2-receipt\0"),
  handshake: Buffer.from("agent-comm-v2-handshake\0"),
  managed: Buffer.from("agent-comm-v2-managed-console\0"),
} as const;
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");
const MAX_V2_BYTES = 512 << 10;
export const V2_AGENT_CONTENT_TYPE = "application/agent-comm+json";

type Scalar = "string" | "integer" | "boolean" | "bytes";
type Schema = ReadonlyArray<readonly [string, Scalar | Schema | { array: Scalar | Schema }]>;
const slotSchema: Schema = [["role", "string"], ["key_id", "string"], ["enc", "bytes"], ["ciphertext", "bytes"]];
const headerSchema: Schema = [
  ["version", "integer"], ["platform_id", "string"], ["policy_epoch", "integer"], ["policy_hash", "string"],
  ["mode", "string"], ["suite", "string"], ["sender_urn", "string"], ["recipient_urn", "string"],
  ["session_id", "string"], ["direction", "string"], ["sequence", "integer"], ["message_id", "string"],
  ["expiry", "integer"], ["content_type", "string"], ["recipient_key_id", "string"],
  ["gateway_key_id", "string"], ["slot_roles", { array: "string" }],
];
const policySchema: Schema = [
  ["version", "integer"], ["platform_id", "string"], ["epoch", "integer"], ["not_before", "integer"],
  ["expires_at", "integer"], ["mode", "string"], ["suite", "string"], ["gateway_key_id", "string"],
  ["gateway_public_key", "bytes"], ["receipt_key_id", "string"], ["receipt_public_key", "bytes"],
  ["allow_v1", "boolean"], ["managed_issuer_public_key", "bytes"], ["signature", "bytes"],
];
const envelopeSchema: Schema = [
  ["header", headerSchema], ["nonce", "bytes"], ["ciphertext", "bytes"],
  ["slots", { array: slotSchema }], ["signature", "bytes"],
];
const receiptSchema: Schema = [
  ["version", "integer"], ["platform_id", "string"], ["envelope_hash", "string"], ["policy_hash", "string"],
  ["gateway_key_id", "string"], ["receipt_key_id", "string"], ["admitted_at", "integer"],
  ["result", "string"], ["proof", "bytes"], ["signature", "bytes"],
];
const handshakeSchema: Schema = [
  ["version", "integer"], ["type", "string"], ["session_id", "string"], ["sender_urn", "string"],
  ["recipient_urn", "string"], ["payload", "bytes"], ["signature", "bytes"],
];
const managedSchema: Schema = [
  ["version", "integer"], ["role", "string"], ["platform_id", "string"], ["urn", "string"],
  ["identity_public_key", "bytes"], ["not_before", "integer"], ["expires_at", "integer"],
  ["serial", "string"], ["signature", "bytes"],
];

export interface V2Policy {
  version: number; platform_id: string; epoch: number; not_before: number; expires_at: number;
  mode: "private" | "compliance"; suite: string; gateway_key_id: string;
  gateway_public_key: string | null; receipt_key_id: string; receipt_public_key: string | null;
  allow_v1: boolean; managed_issuer_public_key: string | null; signature: string;
}
export interface V2Header {
  version: number; platform_id: string; policy_epoch: number; policy_hash: string;
  mode: "private" | "compliance"; suite: string; sender_urn: string; recipient_urn: string;
  session_id: string; direction: string; sequence: number; message_id: string; expiry: number;
  content_type: string; recipient_key_id: string; gateway_key_id: string; slot_roles: string[];
}
export interface V2Slot { role: string; key_id: string; enc: string | null; ciphertext: string | null }
export interface V2Envelope { header: V2Header; nonce: string | null; ciphertext: string | null; slots: V2Slot[]; signature: string }
export interface V2Receipt {
  version: number; platform_id: string; envelope_hash: string; policy_hash: string; gateway_key_id: string;
  receipt_key_id: string; admitted_at: number; result: string; proof: string | null; signature: string;
}
export interface V2HandshakeFrame {
  version: number; type: string; session_id: string; sender_urn: string; recipient_urn: string;
  payload: string | null; signature: string;
}
export interface V2ManagedCertificate {
  version: number; role: "managed_console"; platform_id: string; urn: string;
  identity_public_key: string; not_before: number; expires_at: number; serial: string; signature: string;
}

function normalize(value: unknown, schema: Schema): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid v2 object");
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== schema.length) throw new Error("Unexpected v2 field");
  const result: Record<string, unknown> = {};
  for (const [name, kind] of schema) {
    if (!Object.prototype.hasOwnProperty.call(object, name)) throw new Error(`Missing v2 field: ${name}`);
    const item = object[name];
    if (typeof kind === "string") {
      if (kind === "integer") {
        if (typeof item !== "number" || !Number.isSafeInteger(item)) throw new Error(`Invalid v2 integer: ${name}`);
      } else if (kind === "bytes") {
        if (item !== null && (typeof item !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(item) ||
            Buffer.from(item, "base64").toString("base64") !== item)) throw new Error(`Invalid v2 base64: ${name}`);
      } else if (typeof item !== kind) throw new Error(`Invalid v2 ${kind}: ${name}`);
      if (kind === "string") {
        for (let index = 0; index < (item as string).length; index++) {
          const code = (item as string).charCodeAt(index);
          if (code >= 0xd800 && code <= 0xdbff) {
            const next = (item as string).charCodeAt(++index);
            if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error(`Invalid v2 Unicode: ${name}`);
          } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error(`Invalid v2 Unicode: ${name}`);
        }
      }
      result[name] = item;
    } else if (Array.isArray(kind)) result[name] = normalize(item, kind as Schema);
    else {
      const arrayKind = (kind as { array: Scalar | Schema }).array;
      if (!Array.isArray(item)) throw new Error(`Invalid v2 array: ${name}`);
      result[name] = item.map(member => typeof arrayKind === "string"
        ? normalize({ member }, [["member", arrayKind]]).member : normalize(member, arrayKind));
    }
  }
  return result;
}

function goJSONStringify(value: unknown): string {
  // Go's JSON encoder always escapes these two separators even with HTML escaping off.
  return JSON.stringify(value).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

function encode(value: unknown, schema: Schema, limit = MAX_V2_BYTES): Buffer {
  const result = Buffer.from(goJSONStringify(normalize(value, schema)), "utf8");
  if (result.length > limit) throw new Error("V2 frame exceeds size limit");
  return result;
}

function decode<T>(raw: Buffer, schema: Schema, limit = MAX_V2_BYTES): T {
  if (!Buffer.isBuffer(raw) || raw.length === 0 || raw.length > limit) throw new Error("Invalid v2 frame size");
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { throw new Error("Invalid v2 JSON"); }
  if (!encode(value, schema, limit).equals(raw)) throw new Error("Noncanonical v2 JSON");
  return value as T;
}

function signingBytes(value: Record<string, unknown>, schema: Schema, kind: keyof typeof DOMAIN): Buffer {
  return Buffer.concat([DOMAIN[kind], encode({ ...value, signature: null }, schema)]);
}

function edPublic(raw: Buffer): crypto.KeyObject {
  if (raw.length !== 32) throw new Error("Invalid Ed25519 public key length");
  return crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), type: "spki", format: "der" });
}

function verifySignature(value: Record<string, unknown>, schema: Schema, kind: keyof typeof DOMAIN, rawPublic: Buffer): void {
  const signature = Buffer.from(value.signature as string, "base64");
  if (signature.length !== 64 || !crypto.verify(null, signingBytes(value, schema, kind), edPublic(rawPublic), signature))
    throw new Error(`Invalid v2 ${kind} signature`);
}

export const encodeV2Policy = (value: V2Policy) => encode(value, policySchema, 16 << 10);
export const decodeV2Policy = (raw: Buffer) => decode<V2Policy>(raw, policySchema, 16 << 10);
export const encodeV2Header = (value: V2Header) => encode(value, headerSchema);
export const encodeV2Envelope = (value: V2Envelope) => encode(value, envelopeSchema);
export const decodeV2Envelope = (raw: Buffer) => decode<V2Envelope>(raw, envelopeSchema);
export const encodeV2Receipt = (value: V2Receipt) => encode(value, receiptSchema, 16 << 10);
export const decodeV2Receipt = (raw: Buffer) => decode<V2Receipt>(raw, receiptSchema, 16 << 10);
export const encodeV2Handshake = (value: V2HandshakeFrame) => encode(value, handshakeSchema, 16 << 10);
export const decodeV2Handshake = (raw: Buffer) => decode<V2HandshakeFrame>(raw, handshakeSchema, 16 << 10);
export const encodeV2ManagedCertificate = (value: V2ManagedCertificate) => encode(value, managedSchema, 8 << 10);
export const decodeV2ManagedCertificate = (raw: Buffer) => decode<V2ManagedCertificate>(raw, managedSchema, 8 << 10);
export const v2Hash = (raw: Buffer) => crypto.createHash("sha256").update(raw).digest("hex");

export function signV2Envelope(value: Omit<V2Envelope, "signature">, senderPrivateKey: crypto.KeyObject): Buffer {
  if (senderPrivateKey.type !== "private" || senderPrivateKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid v2 sender key");
  if (value.header.content_type !== V2_AGENT_CONTENT_TYPE) throw new Error("Unsupported v2 content type");
  const publicKey = crypto.createPublicKey(senderPrivateKey).export({ type: "spki", format: "der" }).subarray(-32);
  if (!urnMatchesPublicKey(value.header.sender_urn, publicKey)) throw new Error("V2 sender identity mismatch");
  const envelope: V2Envelope = { ...value, signature: "" };
  envelope.signature = crypto.sign(null, signingBytes(envelope as unknown as Record<string, unknown>, envelopeSchema, "envelope"), senderPrivateKey).toString("base64");
  return encodeV2Envelope(envelope);
}

export function signV2ManagedCertificate(value: Omit<V2ManagedCertificate, "signature">, issuerPrivateKey: crypto.KeyObject): Buffer {
  if (issuerPrivateKey.type !== "private" || issuerPrivateKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid managed issuer key");
  const certificate: V2ManagedCertificate = { ...value, signature: "" };
  certificate.signature = crypto.sign(null, signingBytes(certificate as unknown as Record<string, unknown>, managedSchema, "managed"), issuerPrivateKey).toString("base64");
  return encodeV2ManagedCertificate(certificate);
}

export function verifyV2ManagedCertificate(raw: Buffer, policyRaw: Buffer, now = Math.floor(Date.now() / 1000)): V2ManagedCertificate {
  const certificate = decodeV2ManagedCertificate(raw), policy = decodeV2Policy(policyRaw);
  if (certificate.version !== 2 || certificate.role !== "managed_console" || certificate.platform_id !== policy.platform_id ||
      certificate.urn.length > 256 || certificate.not_before <= 0 || certificate.expires_at <= certificate.not_before ||
      certificate.not_before > now || certificate.expires_at <= now ||
      !certificate.serial || !policy.managed_issuer_public_key ||
      !urnMatchesPublicKey(certificate.urn, Buffer.from(certificate.identity_public_key, "base64")))
    throw new Error("Invalid or expired managed console certificate");
  verifySignature(certificate as unknown as Record<string, unknown>, managedSchema, "managed", Buffer.from(policy.managed_issuer_public_key, "base64"));
  return certificate;
}

export function verifyV2Policy(raw: Buffer, rootPublicKey: Buffer, now = Math.floor(Date.now() / 1000)): V2Policy {
  const policy = decodeV2Policy(raw);
  if (policy.version !== 2 || !policy.platform_id || !Number.isSafeInteger(policy.epoch) || policy.epoch < 1 ||
      policy.not_before <= 0 || policy.not_before > now || policy.expires_at <= now || policy.not_before >= policy.expires_at ||
      !["private", "compliance"].includes(policy.mode) || policy.suite !== "X25519-HKDF-SHA256-AES256GCM" ||
      !policy.receipt_key_id || !policy.receipt_public_key || Buffer.from(policy.receipt_public_key, "base64").length !== 32 ||
      (policy.managed_issuer_public_key !== null && Buffer.from(policy.managed_issuer_public_key, "base64").length !== 0 &&
        Buffer.from(policy.managed_issuer_public_key, "base64").length !== 32) ||
      (policy.mode === "compliance" && (policy.allow_v1 || !policy.gateway_key_id || !policy.gateway_public_key ||
        Buffer.from(policy.gateway_public_key, "base64").length !== 32)))
    throw new Error("Invalid or expired v2 policy");
  verifySignature(policy as unknown as Record<string, unknown>, policySchema, "policy", rootPublicKey);
  return policy;
}

export function verifyV2Envelope(raw: Buffer, policyRaw: Buffer, senderPublicKey: Buffer, expectedRecipient: string,
  now = Math.floor(Date.now() / 1000)): V2Envelope {
  const policy = decodeV2Policy(policyRaw), env = decodeV2Envelope(raw), h = env.header;
  if (h.version !== 2 || h.platform_id !== policy.platform_id || h.policy_epoch !== policy.epoch ||
      h.policy_hash !== v2Hash(policyRaw) || h.mode !== policy.mode || h.suite !== policy.suite ||
      h.recipient_urn !== expectedRecipient || !urnMatchesPublicKey(h.sender_urn, senderPublicKey) ||
      h.sender_urn === h.recipient_urn || !h.session_id || !h.message_id || !h.recipient_key_id ||
      h.content_type !== V2_AGENT_CONTENT_TYPE ||
      !["a_to_b", "b_to_a"].includes(h.direction) || h.expiry <= now || h.sequence < 1 ||
      !env.nonce || Buffer.from(env.nonce, "base64").length !== 12 || !env.ciphertext ||
      Buffer.from(env.ciphertext, "base64").length < 16)
    throw new Error("V2 envelope does not match recipient, sender or policy");
  const roles = h.mode === "private" ? [] : ["recipient", "gateway"];
  if (JSON.stringify(h.slot_roles) !== JSON.stringify(roles) || env.slots.length !== roles.length ||
      env.slots.some((slot, index) => slot.role !== roles[index]) ||
      (h.mode === "private" && h.gateway_key_id !== "") ||
      (h.mode === "compliance" && (h.gateway_key_id !== policy.gateway_key_id || env.slots[0].key_id !== h.recipient_key_id ||
        env.slots[1].key_id !== policy.gateway_key_id || env.slots.some(slot => !slot.enc || !slot.ciphertext ||
          Buffer.from(slot.enc, "base64").length !== 32 || Buffer.from(slot.ciphertext, "base64").length !== 48))))
    throw new Error("Invalid v2 key slots");
  verifySignature(env as unknown as Record<string, unknown>, envelopeSchema, "envelope", senderPublicKey);
  return env;
}

export function verifyV2Receipt(raw: Buffer, envelopeRaw: Buffer, policyRaw: Buffer, cek?: Buffer,
  now = Math.floor(Date.now() / 1000)): V2Receipt {
  const receipt = decodeV2Receipt(raw), policy = decodeV2Policy(policyRaw);
  if (receipt.version !== 2 || receipt.platform_id !== policy.platform_id || receipt.policy_hash !== v2Hash(policyRaw) ||
      receipt.envelope_hash !== v2Hash(envelopeRaw) || receipt.gateway_key_id !== policy.gateway_key_id ||
      receipt.receipt_key_id !== policy.receipt_key_id || !policy.receipt_public_key ||
      receipt.admitted_at < policy.not_before || receipt.admitted_at >= policy.expires_at || receipt.admitted_at > now + 60)
    throw new Error("V2 receipt does not bind the policy and envelope");
  verifySignature(receipt as unknown as Record<string, unknown>, receiptSchema, "receipt", Buffer.from(policy.receipt_public_key, "base64"));
  if (policy.mode === "compliance") {
    if (receipt.result !== "decrypted-admitted" || !receipt.proof || !cek || cek.length !== 32) throw new Error("Missing v2 gateway proof");
    const proofKey = Buffer.from(crypto.hkdfSync("sha256", cek, Buffer.alloc(32), Buffer.from("agent-comm-v2/admission-proof"), 32));
    const expected = crypto.createHmac("sha256", proofKey).update(Buffer.from(receipt.envelope_hash, "hex")).digest();
    const actual = Buffer.from(receipt.proof, "base64");
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) throw new Error("Invalid v2 gateway proof");
  } else if (receipt.result !== "accepted-uninspected" || (receipt.proof !== null && receipt.proof !== ""))
    throw new Error("Invalid v2 private receipt result");
  return receipt;
}

export function verifyV2Handshake(raw: Buffer, senderPublicKey: Buffer, expectedRecipient: string): V2HandshakeFrame {
  const frame = decodeV2Handshake(raw);
  if (frame.version !== 2 || frame.recipient_urn !== expectedRecipient ||
      !urnMatchesPublicKey(frame.sender_urn, senderPublicKey) || !frame.session_id || !frame.payload ||
      !["init", "accept", "finished"].includes(frame.type)) throw new Error("Invalid v2 handshake identity");
  verifySignature(frame as unknown as Record<string, unknown>, handshakeSchema, "handshake", senderPublicKey);
  return frame;
}
