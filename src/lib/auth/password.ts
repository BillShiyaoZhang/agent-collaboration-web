import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { compare } from "bcryptjs";

export const MAX_PASSWORD_BYTES = 1024;
const PREFIX = "$scrypt$v1$";
const OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, OPTIONS, (error, key) => error ? reject(error) : resolve(key));
  });
}

export function validPasswordSize(password: unknown): password is string {
  return typeof password === "string" && password.length > 0 && Buffer.byteLength(password, "utf8") <= MAX_PASSWORD_BYTES;
}

export function passwordNeedsUpgrade(value: string): boolean { return /^\$2[aby]\$/.test(value); }

export async function hashPassword(password: string): Promise<string> {
  if (!validPasswordSize(password)) throw new Error("Invalid password length");
  const salt = randomBytes(16), key = await derive(password, salt);
  return PREFIX + salt.toString("base64url") + "$" + key.toString("base64url");
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (!validPasswordSize(password)) return false;
  // Existing bcrypt hashes retain their historical verification semantics until
  // successful login upgrades them. The original >72-byte suffix is unrecoverable.
  if (passwordNeedsUpgrade(encoded)) return compare(password, encoded);
  const match = /^\$scrypt\$v1\$([A-Za-z0-9_-]{22})\$([A-Za-z0-9_-]{86})$/.exec(encoded);
  if (!match) return false;
  const key = await derive(password, Buffer.from(match[1], "base64url"));
  return timingSafeEqual(key, Buffer.from(match[2], "base64url"));
}
