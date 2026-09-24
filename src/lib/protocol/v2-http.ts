import crypto from "crypto";
import { urnMatchesPublicKey } from "@/lib/protocol/protocol-auth";
import { decodeV2Envelope, decodeV2Handshake, verifyV2Envelope, verifyV2Handshake,
  verifyV2Policy, verifyV2Receipt, v2Hash, type V2Policy, type V2Receipt } from "@/lib/protocol/v2";

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

function canonicalBase64(value: unknown, limit: number): Buffer {
  if (typeof value !== "string" || value.length > Math.ceil(limit / 3) * 4 + 4 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error("Invalid v2 transport base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > limit || bytes.toString("base64") !== value) throw new Error("Invalid v2 transport bytes");
  return bytes;
}

export type V2MessageItem = { message_id: string; envelope: Buffer; receipt: Buffer };
export type V2FrameItem = { frame_id: string; frame: Buffer };

/** Transport only. Callers pin identities, persist policy epochs and session/outbox state. */
export class V2HTTPClient {
  readonly publicKey: Buffer;
  constructor(readonly baseURL: string, readonly urn: string, readonly signingKey: crypto.KeyObject,
    readonly send: typeof fetch = fetch) {
    if (signingKey.type !== "private" || signingKey.asymmetricKeyType !== "ed25519") throw new Error("Ed25519 client identity required");
    const publicDER = crypto.createPublicKey(signingKey).export({ type: "spki", format: "der" });
    if (!publicDER.subarray(0, ED25519_SPKI.length).equals(ED25519_SPKI)) throw new Error("Invalid Ed25519 key");
    this.publicKey = publicDER.subarray(-32);
    if (!urnMatchesPublicKey(urn, this.publicKey)) throw new Error("V2 client URN does not match identity key");
  }

  private async request(path: string, method: "GET" | "POST", body?: Record<string, unknown>, auth = true): Promise<Record<string, unknown>> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = {};
    if (text !== undefined) headers["Content-Type"] = "application/json";
    if (auth && method === "GET") {
      const timestamp = Math.floor(Date.now() / 1000), bytes = Buffer.alloc(8);
      bytes.writeBigUInt64BE(BigInt(timestamp));
      const preimage = Buffer.concat([Buffer.from(`mq-retrieve|${this.urn}|`), bytes]);
      headers["X-URN"] = this.urn; headers["X-Timestamp"] = String(timestamp);
      headers["X-Pubkey"] = this.publicKey.toString("hex");
      headers["X-Signature"] = crypto.sign(null, preimage, this.signingKey).toString("hex");
    } else if (auth) {
      const signed = Buffer.from(text || "");
      headers.Authorization = `Ed25519 ${crypto.sign(null, signed, this.signingKey).toString("hex")}:${this.publicKey.toString("hex")}`;
    }
    const response = await this.send(`${this.baseURL.replace(/\/$/, "")}${path}`, {
      method, headers, body: text, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20000),
    });
    if (!response.ok) throw new Error(`V2 platform ${path}: HTTP ${response.status}`);
    const result = await response.text();
    if (Buffer.byteLength(result) > (2 << 20)) throw new Error("V2 platform response too large");
    let parsed: unknown;
    try { parsed = JSON.parse(result); } catch { throw new Error("Invalid v2 platform JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Invalid v2 platform response");
    return parsed as Record<string, unknown>;
  }

  async fetchPolicy(root: Buffer, expectedPlatformID: string, highestEpoch = 0): Promise<{ raw: Buffer; policy: V2Policy }> {
    const response = await this.request("/api/v2/policy", "GET", undefined, false);
    const raw = canonicalBase64(response.policy, 16 << 10), policy = verifyV2Policy(raw, root);
    if (policy.platform_id !== expectedPlatformID || policy.epoch < highestEpoch) throw new Error("V2 platform policy rollback or identity mismatch");
    return { raw, policy };
  }

  async storeEnvelope(policyRaw: Buffer, root: Buffer, expectedPlatformID: string, raw: Buffer, cek?: Buffer): Promise<V2Receipt> {
    const env = decodeV2Envelope(raw), policy = verifyV2Policy(policyRaw, root);
    if (policy.platform_id !== expectedPlatformID) throw new Error("Unexpected v2 platform ID");
    if (env.header.sender_urn !== this.urn) throw new Error("Cannot store another sender's v2 envelope");
    verifyV2Envelope(raw, policyRaw, this.publicKey, env.header.recipient_urn);
    const result = await this.request("/api/v2/mq/store", "POST", {
      recipient_urn: env.header.recipient_urn, expiry_unix: env.header.expiry, envelope: raw.toString("base64"),
    });
    if (result.ok !== true || result.message_id !== env.header.message_id) throw new Error("V2 store message ID mismatch");
    const receiptRaw = canonicalBase64(result.receipt, 16 << 10);
    return verifyV2Receipt(receiptRaw, raw, policyRaw, cek);
  }

  async retrieveMessages(): Promise<V2MessageItem[]> {
    const result = await this.request("/api/v2/mq/retrieve", "GET");
    if (!Array.isArray(result.messages) || result.messages.length > 100) throw new Error("Invalid v2 mailbox response");
    return result.messages.map(item => {
      if (!item || typeof item !== "object" || typeof item.message_id !== "string") throw new Error("Invalid v2 mailbox item");
      return { message_id: item.message_id, envelope: canonicalBase64(item.envelope, 512 << 10),
        receipt: canonicalBase64(item.receipt, 16 << 10) };
    });
  }

  async ackMessages(messageIDs: string[]): Promise<void> {
    if (messageIDs.length === 0) return;
    const result = await this.request("/api/v2/mq/ack", "POST", {
      recipient_urn: this.urn, timestamp: Math.floor(Date.now() / 1000), message_ids: Array.from(new Set(messageIDs)),
    });
    if (result.ok !== true) throw new Error("V2 message ACK failed");
  }

  async storeFrame(raw: Buffer): Promise<string> {
    const frame = decodeV2Handshake(raw);
    if (frame.sender_urn !== this.urn) throw new Error("Cannot store another sender's handshake frame");
    verifyV2Handshake(raw, this.publicKey, frame.recipient_urn);
    const result = await this.request("/api/v2/handshake/store", "POST", { frame: raw.toString("base64") });
    const id = v2Hash(raw);
    if (result.ok !== true || result.frame_id !== id) throw new Error("V2 handshake frame ID mismatch");
    return id;
  }

  async retrieveFrames(limit = 100): Promise<V2FrameItem[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid v2 handshake limit");
    const result = await this.request("/api/v2/handshake/retrieve", "POST", { recipient_urn: this.urn, limit });
    if (!Array.isArray(result.frames) || result.frames.length > limit) throw new Error("Invalid v2 handshake mailbox");
    return result.frames.map(item => {
      if (!item || typeof item !== "object" || typeof item.frame_id !== "string") throw new Error("Invalid v2 frame item");
      const frame = canonicalBase64(item.frame, 16 << 10);
      if (item.frame_id !== v2Hash(frame)) throw new Error("V2 frame hash mismatch");
      return { frame_id: item.frame_id, frame };
    });
  }

  async ackFrames(frameIDs: string[]): Promise<void> {
    if (frameIDs.length === 0) return;
    const result = await this.request("/api/v2/handshake/ack", "POST", {
      recipient_urn: this.urn, frame_ids: Array.from(new Set(frameIDs)),
    });
    if (result.ok !== true) throw new Error("V2 handshake ACK failed");
  }
}
