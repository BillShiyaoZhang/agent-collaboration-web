import crypto from "crypto";

const PROTO_AAD_CONST = "agent-comm-v1";
const EPHEMERAL_INFO_CONST = "agent-comm-ephemeral-v1";

// Prefix for X25519 PKCS8 private key DER (16 bytes)
const X25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");

// Prefix for X25519 SPKI public key DER (12 bytes)
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function rawPrivateKeyToKeyObject(rawKey: Buffer): crypto.KeyObject {
  if (rawKey.length !== 32) {
    throw new Error("Invalid raw X25519 private key: must be 32 bytes");
  }
  const pkcs8 = Buffer.concat([X25519_PKCS8_PREFIX, rawKey]);
  return crypto.createPrivateKey({
    key: pkcs8,
    format: "der",
    type: "pkcs8"
  });
}

export function rawPublicKeyToKeyObject(rawKey: Buffer): crypto.KeyObject {
  if (rawKey.length !== 32) {
    throw new Error("Invalid raw X25519 public key: must be 32 bytes");
  }
  const spki = Buffer.concat([X25519_SPKI_PREFIX, rawKey]);
  return crypto.createPublicKey({
    key: spki,
    format: "der",
    type: "spki"
  });
}

// Compute X25519 Diffie-Hellman Shared Secret
export function computeSharedSecret(rawPrivateKey: Buffer, rawPublicKey: Buffer): Buffer {
  const privKeyObj = rawPrivateKeyToKeyObject(rawPrivateKey);
  const pubKeyObj = rawPublicKeyToKeyObject(rawPublicKey);

  const sharedSecret = crypto.diffieHellman({
    privateKey: privKeyObj,
    publicKey: pubKeyObj
  });

  // Verify it's not all zeros (low-order point attack check)
  if (sharedSecret.equals(Buffer.alloc(32))) {
    throw new Error("Invalid shared secret (low-order point check failed)");
  }

  return sharedSecret;
}

// Derive AES key via HKDF-SHA256
export function deriveKeys(sharedSecret: Buffer, info: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", sharedSecret, Buffer.alloc(0), info, 32));
}

// Derive Ephemeral key via HKDF-SHA256
export function deriveEphemeral(sharedSecret: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync(
      "sha256",
      sharedSecret,
      Buffer.alloc(0),
      Buffer.from(EPHEMERAL_INFO_CONST, "utf8"),
      32
    )
  );
}

// ECIES Encrypt matching Go ECIES.EncryptWithSharedSecret
export function encryptWithSharedSecret(
  sharedSecret: Buffer,
  plaintext: Buffer
): { ephemeral: Buffer; nonce: Buffer; ciphertext: Buffer; tag: Buffer } {
  const ephemeral = deriveEphemeral(sharedSecret);
  const encKey = deriveKeys(sharedSecret, ephemeral);
  const nonce = crypto.randomBytes(12);

  // AAD is first 16 bytes of SHA-256 hash of ProtoAAD
  const protoAadHash = crypto.createHash("sha256").update(PROTO_AAD_CONST, "utf8").digest();
  const aad = protoAadHash.subarray(0, 16);

  const cipher = crypto.createCipheriv("aes-256-gcm", encKey, nonce);
  cipher.setAAD(aad);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();

  return {
    ephemeral,
    nonce,
    ciphertext,
    tag
  };
}

// ECIES Decrypt matching Go ECIES.DecryptWithSharedSecret
export function decryptWithSharedSecret(
  sharedSecret: Buffer,
  ephemeral: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
  tag: Buffer
): Buffer {
  const encKey = deriveKeys(sharedSecret, ephemeral);

  // AAD is first 16 bytes of SHA-256 hash of ProtoAAD
  const protoAadHash = crypto.createHash("sha256").update(PROTO_AAD_CONST, "utf8").digest();
  const aad = protoAadHash.subarray(0, 16);

  const decipher = crypto.createDecipheriv("aes-256-gcm", encKey, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
}
