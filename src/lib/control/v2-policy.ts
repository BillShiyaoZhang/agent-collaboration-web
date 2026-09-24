import crypto from "crypto";
import fs from "fs";
import type { User } from "@prisma/client";
import { prisma } from "@/lib/shared/db";
import { signV2ManagedCertificate, verifyV2ManagedCertificate, verifyV2Policy, v2Hash } from "@/lib/protocol/v2";
import type { PolicyDisclosure } from "@/lib/control/policy-disclosure-types";

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const POLICY_PATH = "/api/v2/policy";

export class PolicyChangedError extends Error {}
export class PolicyConsentRequiredError extends Error {}

type ConsoleKeys = { urn: string; publicKey: string; signingKey: crypto.KeyObject };

function strictBase64(value: unknown): Buffer {
  if (typeof value !== "string" || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value))
    throw new Error("Invalid platform base64");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) throw new Error("Noncanonical platform base64");
  return bytes;
}

function policyRoot(): Buffer | null {
  const configured = process.env.AGENT_V2_POLICY_ROOT_PUBLIC_KEY;
  if (!configured) return null;
  if (!/^[a-fA-F0-9]{64}$/.test(configured)) throw new Error("Invalid v2 policy root configuration");
  return Buffer.from(configured, "hex");
}

function issuerKey(): crypto.KeyObject {
  const inline = process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY;
  const file = process.env.AGENT_MANAGED_ISSUER_PRIVATE_KEY_FILE;
  if (inline && file) throw new Error("Choose one managed issuer key source");
  let raw: Buffer;
  if (file) raw = fs.readFileSync(file);
  else if (inline && /^(?:[a-fA-F0-9]{64}|[a-fA-F0-9]{128})$/.test(inline)) raw = Buffer.from(inline, "hex");
  else throw new Error("Managed console issuer is not configured");
  if (raw.length !== 32 && raw.length !== 64) throw new Error("Invalid managed issuer private key length");
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, raw.subarray(0, 32)]), type: "pkcs8", format: "der" });
  if (raw.length === 64) {
    const publicKey = crypto.createPublicKey(key).export({ type: "spki", format: "der" }).subarray(-32);
    if (!crypto.timingSafeEqual(publicKey, raw.subarray(32))) throw new Error("Managed issuer private and public key mismatch");
  }
  return key;
}

async function platformRequest(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(`${process.env.AGENT_PLATFORM_URL || "http://localhost:8080"}${path}`, {
      ...init, cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10000),
    });
  } catch { throw new Error("Unable to obtain platform policy or managed enrollment"); }
}

async function policyForConsole(): Promise<{ raw: Buffer; policy: ReturnType<typeof verifyV2Policy> } | null> {
  const response = await platformRequest(POLICY_PATH);
  if (response.status === 404) {
    // Only pre-v2 deployments may use the legacy control path without a signed policy.
    if (policyRoot() || await prisma.platformPolicyState.findFirst({ select: { platformId: true } }))
      throw new Error("Pinned v2 policy is unavailable");
    return null;
  }
  if (!response.ok) throw new Error(`Platform policy HTTP ${response.status}`);
  const root = policyRoot(), expectedID = process.env.AGENT_V2_PLATFORM_ID;
  if (!root || !expectedID) throw new Error("V2 policy root and platform ID must be pinned");
  const text = await response.text();
  if (text.length > 16384) throw new Error("Platform policy response is too large");
  let document: unknown;
  try { document = JSON.parse(text); } catch { throw new Error("Invalid platform policy response"); }
  if (!document || typeof document !== "object" || Array.isArray(document) ||
      Object.keys(document).length !== 1 || !("policy" in document)) throw new Error("Invalid platform policy response");
  const raw = strictBase64((document as { policy: unknown }).policy);
  const policy = verifyV2Policy(raw, root);
  if (policy.platform_id !== expectedID) throw new Error("Unexpected v2 platform ID");
  const hash = v2Hash(raw);
  await prisma.$transaction(async db => {
    const state = await db.platformPolicyState.findUnique({ where: { platformId: policy.platform_id } });
    if (state && (BigInt(policy.epoch) < state.epoch || BigInt(policy.epoch) === state.epoch && hash !== state.policyHash))
      throw new Error("Platform policy rollback or equivocation");
    if (!state || BigInt(policy.epoch) > state.epoch)
      await db.platformPolicyState.upsert({ where: { platformId: policy.platform_id },
        create: { platformId: policy.platform_id, epoch: BigInt(policy.epoch), policyHash: hash },
        update: { epoch: BigInt(policy.epoch), policyHash: hash } });
  });
  return { raw, policy };
}

function matchesConsent(consent: { platformId: string; epoch: bigint; policyHash: string; gatewayKeyId: string } | null,
  policy: ReturnType<typeof verifyV2Policy>, hash: string): boolean {
  return !!consent && consent.platformId === policy.platform_id && consent.epoch === BigInt(policy.epoch) &&
    consent.policyHash === hash && consent.gatewayKeyId === policy.gateway_key_id;
}

/** Describe only the verified policy. This does not attest that any particular agent used v2. */
export async function readPolicyDisclosure(userId: string): Promise<PolicyDisclosure> {
  const current = await policyForConsole();
  const paused = !!await prisma.userControlPause.findUnique({ where: { userId } });
  if (!current) return { status: "legacy", paused, can_use_workbench: !paused,
    web_console_readable: true, agent_gateway_readable: null };
  const { policy, raw } = current, hash = v2Hash(raw);
  const consent = policy.mode === "compliance"
    ? await prisma.userPolicyConsent.findUnique({ where: { userId } }) : null;
  const confirmed = policy.mode === "compliance" && matchesConsent(consent, policy, hash);
  return { status: "signed", platform_id: policy.platform_id, mode: policy.mode, epoch: policy.epoch,
    policy_hash: hash, gateway_key_id: policy.gateway_key_id, confirmed, paused,
    can_use_workbench: !paused && (policy.mode === "private" || confirmed),
    web_console_readable: true, agent_gateway_readable: policy.mode === "compliance" };
}

export async function requirePolicyAcknowledgement(userId: string): Promise<void> {
  const disclosure = await readPolicyDisclosure(userId);
  if (disclosure.paused) throw new PolicyConsentRequiredError("本账户已暂停新的远程控制与同步。请在政策提示中恢复使用。");
  if (!disclosure.can_use_workbench)
    throw new PolicyConsentRequiredError("请先阅读并确认当前合规政策，再继续使用远程工作台。");
}

export async function pausePolicyUse(userId: string): Promise<void> {
  await prisma.userControlPause.upsert({ where: { userId }, create: { userId }, update: { pausedAt: new Date() } });
}

export async function resumePolicyUse(userId: string): Promise<PolicyDisclosure> {
  const disclosure = await readPolicyDisclosure(userId);
  if (disclosure.status === "signed" && disclosure.mode === "compliance" && !disclosure.confirmed)
    throw new PolicyChangedError("当前合规政策需要重新确认，才能恢复使用。");
  await prisma.userControlPause.deleteMany({ where: { userId } });
  return readPolicyDisclosure(userId);
}

/** The browser confirms a hash it has actually displayed; a stale or swapped policy cannot be accepted. */
export async function confirmPolicyDisclosure(userId: string, expectedHash: string): Promise<PolicyDisclosure> {
  const current = await policyForConsole();
  if (!current || current.policy.mode !== "compliance" || v2Hash(current.raw) !== expectedHash)
    throw new PolicyChangedError("当前政策已变化，请刷新披露内容后重新确认。");
  const { policy } = current;
  await prisma.userPolicyConsent.upsert({ where: { userId },
    create: { userId, platformId: policy.platform_id, epoch: BigInt(policy.epoch),
      policyHash: expectedHash, gatewayKeyId: policy.gateway_key_id },
    update: { platformId: policy.platform_id, epoch: BigInt(policy.epoch),
      policyHash: expectedHash, gatewayKeyId: policy.gateway_key_id, confirmedAt: new Date() } });
  await prisma.userControlPause.deleteMany({ where: { userId } });
  return { status: "signed", platform_id: policy.platform_id, mode: policy.mode, epoch: policy.epoch,
    policy_hash: expectedHash, gateway_key_id: policy.gateway_key_id, confirmed: true, paused: false,
    can_use_workbench: true, web_console_readable: true, agent_gateway_readable: true };
}

async function enrollManagedConsole(user: User, keys: ConsoleKeys, rawPolicy: Buffer,
  policy: ReturnType<typeof verifyV2Policy>, force: boolean): Promise<void> {
  if (!policy.managed_issuer_public_key) throw new Error("Policy has no managed console issuer");
  const issuer = issuerKey();
  const publicKey = crypto.createPublicKey(issuer).export({ type: "spki", format: "der" }).subarray(-32);
  const pinned = strictBase64(policy.managed_issuer_public_key);
  if (pinned.length !== 32 || !crypto.timingSafeEqual(publicKey, pinned)) throw new Error("Configured managed issuer does not match signed policy");
  const issuerHash = v2Hash(publicKey), now = Math.floor(Date.now() / 1000);
  const cached = await prisma.managedConsoleCertificate.findUnique({ where: { userId: user.id } });
  if (!force && cached && cached.platformId === policy.platform_id && cached.issuerHash === issuerHash &&
      cached.expiresAt.getTime() > (now + 300) * 1000) {
    try {
      const certificate = verifyV2ManagedCertificate(strictBase64(cached.certificate), rawPolicy, now);
      if (certificate.urn === keys.urn && certificate.identity_public_key === Buffer.from(keys.publicKey, "hex").toString("base64")) return;
    } catch { /* Re-enroll an invalid cached certificate. */ }
  }
  const certificate = signV2ManagedCertificate({ version: 2, role: "managed_console", platform_id: policy.platform_id,
    urn: keys.urn, identity_public_key: Buffer.from(keys.publicKey, "hex").toString("base64"),
    not_before: now - 30, expires_at: now + 3600, serial: crypto.randomUUID() }, issuer);
  const body = JSON.stringify({ certificate: certificate.toString("base64") });
  const authorization = `Ed25519 ${crypto.sign(null, Buffer.from(body), keys.signingKey).toString("hex")}:${keys.publicKey}`;
  const response = await platformRequest("/api/v2/managed/identity", { method: "POST", headers: {
    "Content-Type": "application/json", Authorization: authorization,
  }, body });
  if (!response.ok) throw new Error(`Managed console enrollment HTTP ${response.status}`);
  const result = await response.json() as { ok?: unknown; urn?: unknown; expires_at?: unknown };
  if (result.ok !== true || result.urn !== keys.urn || result.expires_at !== now + 3600)
    throw new Error("Platform did not confirm managed console enrollment");
  await prisma.managedConsoleCertificate.upsert({ where: { userId: user.id },
    create: { userId: user.id, platformId: policy.platform_id, issuerHash, certificate: certificate.toString("base64"), expiresAt: new Date((now + 3600) * 1000) },
    update: { platformId: policy.platform_id, issuerHash, certificate: certificate.toString("base64"), expiresAt: new Date((now + 3600) * 1000) } });
}

/** Require a signed policy decision before sending or consuming a legacy console envelope. */
export async function requireManagedV1(user: User, keys: ConsoleKeys, forceEnrollment = false): Promise<void> {
  if (await prisma.userControlPause.findUnique({ where: { userId: user.id } }))
    throw new PolicyConsentRequiredError("本账户已暂停新的远程控制与同步。请在政策提示中恢复使用。");
  const current = await policyForConsole();
  if (!current) return; // Old platform, with no v2 trust root configured.
  const { policy, raw } = current;
  if (policy.mode === "compliance") {
    const consent = await prisma.userPolicyConsent.findUnique({ where: { userId: user.id } });
    if (!matchesConsent(consent, policy, v2Hash(raw)))
      throw new PolicyConsentRequiredError("请先在工作台确认当前合规政策披露，再继续远程控制。");
  }
  if (policy.mode === "private" && policy.allow_v1) return;
  if (policy.mode === "compliance" && policy.allow_v1) throw new Error("Global v1 is forbidden in compliance policy");
  await enrollManagedConsole(user, keys, raw, policy, forceEnrollment);
}
