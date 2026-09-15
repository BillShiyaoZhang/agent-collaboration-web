import * as crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const ITERATIONS = 100000;

export function generateKeyPair(): {
  publicKey: string;
  privateKey: string;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  return {
    publicKey: Buffer.from(publicKey).toString("base64"),
    privateKey: Buffer.from(privateKey).toString("base64"),
  };
}

export function deriveKey(password: string, salt: Buffer): Buffer {
  return crypto.pbkdf2Sync(password, salt, ITERATIONS, KEY_LENGTH, "sha256");
}

export function encryptPrivateKey(
  privateKey: string,
  password: string
): { encrypted: string; salt: string; iv: string; authTag: string } {
  const salt = crypto.randomBytes(SALT_LENGTH);
  const key = deriveKey(password, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(privateKey, "utf8", "hex");
  encrypted += cipher.final("hex");

  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    salt: salt.toString("hex"),
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
  };
}

export function decryptPrivateKey(
  encrypted: string,
  password: string,
  salt: string,
  iv: string,
  authTag: string
): string {
  const saltBuffer = Buffer.from(salt, "hex");
  const key = deriveKey(password, saltBuffer);
  const ivBuffer = Buffer.from(iv, "hex");
  const authTagBuffer = Buffer.from(authTag, "hex");

  const decipher = crypto.createDecipheriv(ALGORITHM, key, ivBuffer);
  decipher.setAuthTag(authTagBuffer);

  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}

export function generateURN(): string {
  const randomBytes = crypto.randomBytes(16);
  const hash = crypto.createHash("sha256").update(randomBytes).digest("hex");
  return `urn:agent:${hash.substring(0, 32)}`;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Encode(buffer: Buffer): string {
  let result = "";
  let x = BigInt("0x" + buffer.toString("hex"));
  const zero = BigInt(0);
  const fiftyEight = BigInt(58);
  while (x > zero) {
    const modulus = x % fiftyEight;
    x = x / fiftyEight;
    result = BASE58_ALPHABET[Number(modulus)] + result;
  }
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    result = BASE58_ALPHABET[0] + result;
  }
  return result;
}

export function deriveUrnFromEd25519PubKey(pubKeyHex: string): string {
  const pubKeyBytes = Buffer.from(pubKeyHex, "hex");
  const hash = crypto.createHash("sha256").update(pubKeyBytes).digest();
  const fingerprint = base58Encode(hash.subarray(0, 16));
  return `urn:hermes:agent:${fingerprint}`;
}