const crypto = require("node:crypto");
function key(secret) { if (!secret) throw new Error("Moderation encryption is not configured"); return crypto.createHmac("sha256", secret).update("agent-moderation/storage/v1").digest(); }
function seal(secret, userId, agentId, kind, id, body) {
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", key(secret), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([userId, agentId, kind, id])));
  const data = Buffer.concat([cipher.update(JSON.stringify(body), "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}
function unseal(secret, userId, agentId, kind, id, value) {
  const [version, nonce, tag, data, extra] = value.split(".");
  if (version !== "v1" || !nonce || !tag || !data || extra) throw new Error("Invalid moderation ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key(secret), Buffer.from(nonce, "base64"));
  decipher.setAAD(Buffer.from(JSON.stringify([userId, agentId, kind, id]))); decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8"));
}
module.exports = { seal, unseal };
