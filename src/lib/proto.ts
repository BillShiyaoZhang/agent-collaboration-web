// Shared with agent-comm/proto/envelope.proto. Deterministic proto3 encoding
// omits defaults and retains unknown fields for the Go signature preimage.
export const MAX_ENVELOPE_SIZE = 1 << 20;
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_UINT64 = (BigInt(1) << BigInt(64)) - BigInt(1);
const MAX_INT64 = (BigInt(1) << BigInt(63)) - BigInt(1);

export interface EncryptedEnvelope {
  senderUrn: string;
  senderStaticPubkey: Buffer;
  ephemeralPubkey: Buffer;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  messageId: string;
  recipientUrn: string;
  senderEd25519Pubkey: Buffer;
  signature: Buffer;
  unknownFields?: Buffer;
}

export interface ChatMetadata {
  conversationId?: string;
  inReplyTo?: string;
  taskId?: string;
  kind?: string;
  deadline?: string;
  hopLimit?: number;
}

export interface ChatMessage extends ChatMetadata {
  text?: string;
  timestamp?: bigint;
  raw?: Buffer;
}

const metadataNames = {
  conversationId: "conversation_id", inReplyTo: "in_reply_to", taskId: "task_id",
  kind: "kind", deadline: "deadline", hopLimit: "hop_limit",
} as const;

function encodeVarint(value: bigint | number): Buffer {
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new Error("Protobuf integer must be a safe integer or bigint");
  }
  let v = BigInt(value);
  if (v < BigInt(0) || v > MAX_UINT64) throw new Error("Protobuf uint64 out of range");
  const bytes: number[] = [];
  while (v >= BigInt(128)) {
    bytes.push(Number((v & BigInt(127)) | BigInt(128)));
    v >>= BigInt(7);
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

function lengthDelimited(fieldNumber: number, data: Buffer): Buffer {
  return Buffer.concat([encodeVarint(fieldNumber * 8 + 2), encodeVarint(data.length), data]);
}

function bounded(buffer: Buffer): Buffer {
  if (buffer.length > MAX_ENVELOPE_SIZE) throw new Error("Protobuf message exceeds size limit");
  return buffer;
}

class Reader {
  offset = 0;
  constructor(readonly buffer: Buffer) { bounded(buffer); }

  varint(): bigint {
    let result = BigInt(0);
    for (let i = 0; i < 10; i++) {
      if (this.offset >= this.buffer.length) throw new Error("Truncated protobuf varint");
      const byte = this.buffer[this.offset++];
      if (i === 9 && byte > 1) throw new Error("Protobuf varint overflow");
      result |= BigInt(byte & 127) << BigInt(i * 7);
      if ((byte & 128) === 0) return result;
    }
    throw new Error("Protobuf varint overflow");
  }

  tag(): { field: number; wire: number } {
    const tag = this.varint();
    const field = tag >> BigInt(3);
    if (field < BigInt(1) || field > BigInt(0x1fffffff)) throw new Error("Invalid protobuf field number");
    return { field: Number(field), wire: Number(tag & BigInt(7)) };
  }

  take(length: number): Buffer {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.buffer.length - this.offset) {
      throw new Error("Truncated protobuf field");
    }
    const result = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }

  bytes(): Buffer {
    const length = this.varint();
    if (length > BigInt(this.buffer.length - this.offset)) throw new Error("Truncated protobuf field");
    return this.take(Number(length));
  }

  skip(wire: number): void {
    switch (wire) {
      case 0: this.varint(); return;
      case 1: this.take(8); return;
      case 2: this.bytes(); return;
      case 5: this.take(4); return;
      default: throw new Error(`Unsupported protobuf wire type: ${wire}`);
    }
  }
}

function utf8(data: Buffer): string {
  // A BOM is string data in protobuf, including in the signed message ID.
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data);
}

function expectWire(wire: number, expected: number): void {
  if (wire !== expected) throw new Error("Invalid wire type for protobuf field");
}

function claimField(seen: Set<number>, field: number): void {
  if (seen.has(field)) throw new Error("Duplicate protobuf field");
  seen.add(field);
}

export function encodeTextMessage(text: string, timestamp: bigint | number): Buffer {
  if (typeof timestamp === "number" && !Number.isSafeInteger(timestamp)) {
    throw new Error("Timestamp must be a safe integer or bigint");
  }
  const ts = BigInt(timestamp);
  if (ts < -MAX_INT64 - BigInt(1) || ts > MAX_INT64) throw new Error("Timestamp exceeds int64 range");
  return bounded(Buffer.concat([
    ...(text.length ? [lengthDelimited(1, Buffer.from(text, "utf8"))] : []),
    ...(ts !== BigInt(0) ? [encodeVarint(16), encodeVarint(BigInt.asUintN(64, ts))] : []),
  ]));
}

export function decodeTextMessage(buffer: Buffer): ChatMessage {
  const reader = new Reader(buffer);
  const seen = new Set<number>();
  let text = "";
  let timestamp = BigInt(0);
  while (reader.offset < buffer.length) {
    const { field, wire } = reader.tag();
    if (field === 1) {
      claimField(seen, field);
      expectWire(wire, 2);
      text = utf8(reader.bytes());
    } else if (field === 2) {
      claimField(seen, field);
      expectWire(wire, 0);
      timestamp = BigInt.asIntN(64, reader.varint());
    } else reader.skip(wire);
  }
  return { text, timestamp };
}

function validateMetadata(metadata: ChatMetadata): void {
  for (const name of ["conversationId", "inReplyTo", "taskId", "kind"] as const) {
    const value = metadata[name];
    if (value !== undefined && (typeof value !== "string" || Buffer.byteLength(value) > 256)) {
      throw new Error("Chat metadata must be strings of at most 256 bytes");
    }
  }
  if (metadata.hopLimit !== undefined &&
      (!Number.isInteger(metadata.hopLimit) || metadata.hopLimit < 0 || metadata.hopLimit > 64)) {
    throw new Error("hop_limit must be between 0 and 64");
  }
  if (metadata.deadline !== undefined && metadata.deadline !== "") {
    const deadline = metadata.deadline;
    const match = typeof deadline === "string" && deadline.length <= 64
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.exec(deadline) : null;
    if (!match || !Number.isFinite(Date.parse(deadline))) throw new Error("deadline must be RFC3339");
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const monthDays = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    // Date.parse normalizes e.g. February 30 and 24:00; Go time.Parse rejects them.
    if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1] || hour > 23 || minute > 59 || second > 59) {
      throw new Error("deadline must be RFC3339");
    }
  }
}

// The Go helper carries correlation metadata inside encrypted TextMessage.text.
export function encodeChatMessage(text: string, timestamp: bigint | number, metadata?: ChatMetadata): Buffer {
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) throw new Error("Chat text exceeds size limit");
  let wireText = text;
  if (metadata !== undefined) {
    validateMetadata(metadata);
    const wire: Record<string, unknown> = { agent_comm: 1, text };
    for (const name of Object.keys(metadataNames) as (keyof ChatMetadata)[]) {
      if (metadata[name] !== undefined) wire[metadataNames[name]] = metadata[name];
    }
    wireText = JSON.stringify(wire);
  }
  return bounded(lengthDelimited(1, encodeTextMessage(wireText, timestamp)));
}

export function decodeChatMessage(buffer: Buffer): ChatMessage {
  const reader = new Reader(buffer);
  let result: ChatMessage = {};
  while (reader.offset < buffer.length) {
    const { field, wire } = reader.tag();
    if (field === 1) {
      expectWire(wire, 2);
      result = decodeTextMessage(reader.bytes());
    } else if (field === 99) {
      expectWire(wire, 2);
      result = { raw: Buffer.from(reader.bytes()) };
    } else reader.skip(wire);
  }
  if (result.text === undefined) return result;
  let json: unknown;
  try { json = JSON.parse(result.text); } catch { /* ordinary chat text */ }
  if (json !== null && typeof json === "object" && "agent_comm" in json && json.agent_comm === 1) {
    const document = json as Record<string, unknown>;
    if (typeof document.text !== "string") throw new Error("Invalid versioned chat text");
    const metadata: Record<string, unknown> = {};
    for (const name of Object.keys(metadataNames) as (keyof ChatMetadata)[]) {
      if (document[metadataNames[name]] !== undefined) metadata[name] = document[metadataNames[name]];
    }
    validateMetadata(metadata as ChatMetadata);
    result = { text: document.text, timestamp: result.timestamp, ...metadata };
  }
  if (Buffer.byteLength(result.text!) > MAX_TEXT_BYTES) throw new Error("Chat text exceeds size limit");
  return result;
}

const envelopeFields = [
  "senderUrn", "senderStaticPubkey", "ephemeralPubkey", "nonce", "ciphertext",
  "tag", "messageId", "recipientUrn", "senderEd25519Pubkey", "signature",
] as const;

export function encodeEncryptedEnvelope(env: EncryptedEnvelope): Buffer {
  const fields: Buffer[] = [];
  for (let index = 0; index < envelopeFields.length; index++) {
    const value = env[envelopeFields[index]];
    const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    if (!Buffer.isBuffer(data)) throw new Error(`Missing envelope field: ${envelopeFields[index]}`);
    if (data.length) fields.push(lengthDelimited(index + 1, data));
  }
  if (env.unknownFields?.length) {
    const reader = new Reader(env.unknownFields);
    while (reader.offset < reader.buffer.length) {
      const { field, wire } = reader.tag();
      if (field <= envelopeFields.length) throw new Error("Known envelope field in unknownFields");
      reader.skip(wire);
    }
    fields.push(env.unknownFields);
  }
  return bounded(Buffer.concat(fields));
}

export function decodeEncryptedEnvelope(buffer: Buffer): EncryptedEnvelope {
  const env: EncryptedEnvelope = {
    senderUrn: "", senderStaticPubkey: Buffer.alloc(0), ephemeralPubkey: Buffer.alloc(0),
    nonce: Buffer.alloc(0), ciphertext: Buffer.alloc(0), tag: Buffer.alloc(0), messageId: "",
    recipientUrn: "", senderEd25519Pubkey: Buffer.alloc(0), signature: Buffer.alloc(0),
  };
  const reader = new Reader(buffer);
  const seen = new Set<number>();
  const unknown: Buffer[] = [];
  while (reader.offset < buffer.length) {
    const start = reader.offset;
    const { field, wire } = reader.tag();
    if (field <= envelopeFields.length) {
      claimField(seen, field);
      expectWire(wire, 2);
      const data = reader.bytes();
      if (field === 1) env.senderUrn = utf8(data);
      else if (field === 7) env.messageId = utf8(data);
      else if (field === 8) env.recipientUrn = utf8(data);
      else {
        const name = envelopeFields[field - 1] as Exclude<typeof envelopeFields[number], "senderUrn" | "messageId" | "recipientUrn">;
        env[name] = Buffer.from(data);
      }
    } else {
      reader.skip(wire);
      unknown.push(buffer.subarray(start, reader.offset));
    }
  }
  if (unknown.length) env.unknownFields = Buffer.concat(unknown);
  return env;
}
