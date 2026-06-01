// Protobuf varint and length-delimited encoder/decoder for agent-comm protobuf messages.
// Matches envelope.proto schemas.

export interface EncryptedEnvelope {
  senderUrn: string;
  senderStaticPubkey: Buffer;
  ephemeralPubkey: Buffer;
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
  messageId: string;
}

export interface ChatMessage {
  text?: string;
  timestamp?: bigint;
}

// Write integer as protobuf varint
function encodeVarint(value: number | bigint): Buffer {
  const bytes: number[] = [];
  let v = BigInt(value);
  while (v >= BigInt(128)) {
    bytes.push(Number((v & BigInt(0x7f)) | BigInt(0x80)));
    v >>= BigInt(7);
  }
  bytes.push(Number(v));
  return Buffer.from(bytes);
}

// Read varint from buffer at current offset
function decodeVarint(buffer: Buffer, offset: { value: number }): bigint {
  let result = BigInt(0);
  let shift = BigInt(0);
  while (offset.value < buffer.length) {
    const byte = buffer[offset.value++];
    result |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return result;
    }
    shift += BigInt(7);
  }
  throw new Error("Varint overflow or EOF");
}

// Encode field tag and length-delimited bytes (wire type 2)
function encodeLengthDelimited(fieldNumber: number, data: Buffer): Buffer {
  const tag = (fieldNumber << 3) | 2;
  return Buffer.concat([
    encodeVarint(tag),
    encodeVarint(data.length),
    data
  ]);
}

// Encode field tag and varint (wire type 0)
function encodeVarintField(fieldNumber: number, value: number | bigint): Buffer {
  const tag = (fieldNumber << 3) | 0;
  return Buffer.concat([
    encodeVarint(tag),
    encodeVarint(value)
  ]);
}

// --- TextMessage ---
// message TextMessage {
//   string text = 1;
//   int64 timestamp = 2;
// }
export function encodeTextMessage(text: string, timestamp: bigint | number): Buffer {
  const textBuf = Buffer.from(text, "utf8");
  return Buffer.concat([
    encodeLengthDelimited(1, textBuf),
    encodeVarintField(2, timestamp)
  ]);
}

export function decodeTextMessage(buffer: Buffer): ChatMessage {
  let text = "";
  let timestamp = BigInt(0);
  const offset = { value: 0 };
  while (offset.value < buffer.length) {
    const tag = decodeVarint(buffer, offset);
    const fieldNum = Number(tag >> BigInt(3));
    const wireType = Number(tag & BigInt(7));
    if (fieldNum === 1 && wireType === 2) {
      const len = Number(decodeVarint(buffer, offset));
      text = buffer.subarray(offset.value, offset.value + len).toString("utf8");
      offset.value += len;
    } else if (fieldNum === 2 && wireType === 0) {
      timestamp = decodeVarint(buffer, offset);
    } else {
      // Skip unknown fields
      if (wireType === 0) {
        decodeVarint(buffer, offset);
      } else if (wireType === 2) {
        const len = Number(decodeVarint(buffer, offset));
        offset.value += len;
      } else {
        throw new Error(`Unsupported wire type: ${wireType}`);
      }
    }
  }
  return { text, timestamp };
}

// --- ChatMessage ---
// message ChatMessage {
//   oneof body {
//     TextMessage text = 1;
//     bytes raw = 99;
//   }
// }
export function encodeChatMessage(text: string, timestamp: bigint | number): Buffer {
  const txtMsgBuf = encodeTextMessage(text, timestamp);
  return encodeLengthDelimited(1, txtMsgBuf);
}

export function decodeChatMessage(buffer: Buffer): ChatMessage {
  const offset = { value: 0 };
  while (offset.value < buffer.length) {
    const tag = decodeVarint(buffer, offset);
    const fieldNum = Number(tag >> BigInt(3));
    const wireType = Number(tag & BigInt(7));
    if (fieldNum === 1 && wireType === 2) {
      const len = Number(decodeVarint(buffer, offset));
      const subBuf = buffer.subarray(offset.value, offset.value + len);
      offset.value += len;
      return decodeTextMessage(subBuf);
    } else {
      // Skip unknown fields
      if (wireType === 0) {
        decodeVarint(buffer, offset);
      } else if (wireType === 2) {
        const len = Number(decodeVarint(buffer, offset));
        offset.value += len;
      } else {
        throw new Error(`Unsupported wire type: ${wireType}`);
      }
    }
  }
  return {};
}

// --- EncryptedEnvelope ---
// message EncryptedEnvelope {
//   string sender_urn = 1;
//   bytes sender_static_pubkey = 2;
//   bytes ephemeral_pubkey = 3;
//   bytes nonce = 4;
//   bytes ciphertext = 5;
//   bytes tag = 6;
//   string message_id = 7;
// }
export function encodeEncryptedEnvelope(env: EncryptedEnvelope): Buffer {
  return Buffer.concat([
    encodeLengthDelimited(1, Buffer.from(env.senderUrn, "utf8")),
    encodeLengthDelimited(2, env.senderStaticPubkey),
    encodeLengthDelimited(3, env.ephemeralPubkey),
    encodeLengthDelimited(4, env.nonce),
    encodeLengthDelimited(5, env.ciphertext),
    encodeLengthDelimited(6, env.tag),
    encodeLengthDelimited(7, Buffer.from(env.messageId, "utf8"))
  ]);
}

export function decodeEncryptedEnvelope(buffer: Buffer): EncryptedEnvelope {
  const env: Partial<EncryptedEnvelope> = {};
  const offset = { value: 0 };
  while (offset.value < buffer.length) {
    const tag = decodeVarint(buffer, offset);
    const fieldNum = Number(tag >> BigInt(3));
    const wireType = Number(tag & BigInt(7));
    if (wireType === 2) {
      const len = Number(decodeVarint(buffer, offset));
      const data = buffer.subarray(offset.value, offset.value + len);
      offset.value += len;
      switch (fieldNum) {
        case 1: env.senderUrn = data.toString("utf8"); break;
        case 2: env.senderStaticPubkey = Buffer.from(data); break;
        case 3: env.ephemeralPubkey = Buffer.from(data); break;
        case 4: env.nonce = Buffer.from(data); break;
        case 5: env.ciphertext = Buffer.from(data); break;
        case 6: env.tag = Buffer.from(data); break;
        case 7: env.messageId = data.toString("utf8"); break;
      }
    } else {
      if (wireType === 0) {
        decodeVarint(buffer, offset);
      } else {
        throw new Error(`Unsupported wire type: ${wireType}`);
      }
    }
  }
  return env as EncryptedEnvelope;
}
