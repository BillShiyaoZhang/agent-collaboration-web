import crypto from "crypto";
import { z } from "zod";
import { prisma } from "@/lib/shared/db";
import { urnMatchesPublicKey } from "@/lib/protocol/protocol-auth";
import { ControlError, consoleKeys, resolveIdentity } from "./control-transport";
import { ensureConsoleIdentity } from "./console-identity";
import { scheduleWorkspaceSync } from "@/lib/workspace/workspace-store";
import { startWorkspaceSync } from "@/lib/workspace/workspace-sync";

export const ONBOARDING_PROTOCOL = "agent-comm-onboarding/v1";
export const ONBOARDING_METHODS = ["capabilities", "contacts.list", "contacts.requests", "collaboration.state", "inbox.list", "attention.list", "conversation.send", "conversation.get", "contacts.add", "contacts.respond", "messages.send", "inbox.mark_read", "approval.respond", "collaboration.execute"] as const;
const TICKET_MS = 30 * 60 * 1000;
const requestSchema = z.object({
  protocol: z.literal(ONBOARDING_PROTOCOL), agent_urn: z.string().min(10).max(256),
  name: z.string().trim().min(1).max(100), poll_secret_hash: z.string().regex(/^[a-f0-9]{64}$/),
  methods: z.array(z.enum(ONBOARDING_METHODS)).min(1).max(ONBOARDING_METHODS.length),
  expires_at: z.string().datetime({ offset: true }), timestamp: z.number().int(),
}).strict();
type Ticket = { id: string; publicCode: string; agentUrn: string; agentPublicKey: string; name: string;
  secretHash: string; requestHash: string; methods: string; grantExpiresAt: string; ticketExpiresAt: number;
  userId: string | null; agentId: string | null; grant: string | null; signature: string | null;
  consolePublicKey: string | null; completedAt: number | null };
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const missing = () => new ControlError("连接申请无效或已过期，请让 agent 重新发起。", 404);

/** Authenticate the exact bytes before touching storage or trusting a claimed URN. */
export function verifyOnboardingRequest(body: string, authorization: string | null, now = Date.now()) {
  let value: unknown;
  try { value = JSON.parse(body); } catch { throw new ControlError("Invalid JSON", 400); }
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) throw new ControlError("Invalid onboarding request", 400);
  const request = parsed.data, expiry = Date.parse(request.expires_at);
  if (Math.abs(request.timestamp * 1000 - now) > 300000 || expiry <= now || expiry > now + 31 * 86400000 || new Set(request.methods).size !== request.methods.length)
    throw new ControlError("Invalid request time, expiry or methods", 400);
  const match = /^Ed25519 ([a-f0-9]{128}):([a-f0-9]{64})$/.exec(authorization || "");
  if (!match) throw new ControlError("Agent signature required", 401);
  const publicKey = Buffer.from(match[2], "hex");
  if (!urnMatchesPublicKey(request.agent_urn, publicKey) || !crypto.verify(null, Buffer.from(body),
    crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey]), type: "spki", format: "der" }), Buffer.from(match[1], "hex")))
    throw new ControlError("Invalid agent signature", 401);
  return { request, publicKey: match[2], fingerprint: hash(body) };
}

function ticketResponse(ticket: Ticket) {
  const origin = new URL(process.env.NEXTAUTH_URL!).origin;
  return { request_id: ticket.id, claim_url: `${origin}/connect/${ticket.publicCode}`, expires_at: new Date(ticket.ticketExpiresAt).toISOString(), interval: 2 };
}

export async function createOnboarding(body: string, authorization: string | null) {
  const { request, publicKey, fingerprint } = verifyOnboardingRequest(body, authorization);
  if (!process.env.NEXTAUTH_URL) throw new ControlError("Server origin is not configured", 503);
  const registry = await resolveIdentity(request.agent_urn);
  if (Buffer.from(registry.ed25519_pubkey, "base64").toString("hex") !== publicKey) throw new ControlError("Agent registry key mismatch", 401);
  const now = Date.now();
  const ticket = await prisma.$transaction(async db => {
    await db.$executeRaw`DELETE FROM "OnboardingTicket" WHERE ("grant" IS NULL AND "ticketExpiresAt" <= ${now}) OR "ticketExpiresAt" <= ${now - TICKET_MS}`;
    const old = await db.$queryRaw<Ticket[]>`SELECT * FROM "OnboardingTicket" WHERE "requestHash" = ${fingerprint}`;
    if (old[0]) return old[0];
    const counts = await db.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM "OnboardingTicket" WHERE "agentUrn" = ${request.agent_urn}`;
    const total = await db.$queryRaw<{ count: bigint }[]>`SELECT COUNT(*) AS count FROM "OnboardingTicket"`;
    if (Number(counts[0].count) >= 3 || Number(total[0].count) >= 10000) throw new ControlError("Too many pending connection requests", 429);
    const id = crypto.randomUUID(), publicCode = crypto.randomBytes(24).toString("base64url"), ticketExpiresAt = now + TICKET_MS;
    const methods = JSON.stringify(request.methods);
    await db.$executeRaw`INSERT INTO "OnboardingTicket" ("id","publicCode","agentUrn","agentPublicKey","name","secretHash","requestHash","methods","grantExpiresAt","ticketExpiresAt")
      VALUES (${id},${publicCode},${request.agent_urn},${publicKey},${request.name},${request.poll_secret_hash},${fingerprint},${methods},${request.expires_at},${ticketExpiresAt})`;
    return { id, publicCode, ticketExpiresAt } as Ticket;
  });
  return ticketResponse(ticket);
}

async function readTicket(field: "id" | "publicCode", value: string): Promise<Ticket> {
  if (!(field === "id" ? /^[0-9a-f-]{36}$/ : /^[A-Za-z0-9_-]{32}$/).test(value)) throw missing();
  const rows = field === "id" ? await prisma.$queryRaw<Ticket[]>`SELECT * FROM "OnboardingTicket" WHERE "id" = ${value}`
    : await prisma.$queryRaw<Ticket[]>`SELECT * FROM "OnboardingTicket" WHERE "publicCode" = ${value}`;
  // An approval near the deadline still has time to reach the device and be
  // acknowledged. This grace never permits a new Web claim after its deadline.
  if (!rows[0] || rows[0].ticketExpiresAt + (rows[0].grant ? TICKET_MS : 0) <= Date.now()) throw missing();
  return rows[0];
}
async function agentTicket(id: string, authorization: string | null) {
  const secret = /^Bearer ([a-f0-9]{64})$/.exec(authorization || "")?.[1];
  if (!secret) throw new ControlError("Polling secret required", 401);
  const ticket = await readTicket("id", id);
  if (!crypto.timingSafeEqual(Buffer.from(hash(secret), "hex"), Buffer.from(ticket.secretHash, "hex"))) throw new ControlError("Invalid polling secret", 401);
  return ticket;
}
export async function pollOnboarding(id: string, authorization: string | null) {
  const ticket = await agentTicket(id, authorization);
  if (!ticket.grant) return { status: "pending" };
  return { status: ticket.completedAt ? "completed" : "approved", grant: ticket.grant, signature: ticket.signature, public_key: ticket.consolePublicKey, agent_id: ticket.agentId };
}
export async function completeOnboarding(id: string, authorization: string | null) {
  const ticket = await agentTicket(id, authorization);
  if (!ticket.grant || !ticket.agentId || !ticket.userId) throw new ControlError("Web approval is still pending", 409);
  await prisma.$executeRaw`UPDATE "OnboardingTicket" SET "completedAt" = COALESCE("completedAt", ${Date.now()}) WHERE "id" = ${id}`;
  await scheduleWorkspaceSync(ticket.userId, ticket.agentId);
  startWorkspaceSync();
  return { status: "completed" };
}
export async function previewOnboarding(code: string, userId: string) {
  const ticket = await readTicket("publicCode", code);
  if (ticket.userId && ticket.userId !== userId) throw missing();
  return { name: ticket.name, agent_urn: ticket.agentUrn, methods: JSON.parse(ticket.methods) as string[], expires_at: ticket.grantExpiresAt,
    ticket_expires_at: new Date(ticket.ticketExpiresAt).toISOString(), status: ticket.completedAt ? "completed" : ticket.userId ? "approved" : "pending", agent_id: ticket.agentId };
}
export async function approveOnboarding(code: string, userId: string) {
  const ticket = await readTicket("publicCode", code);
  if (ticket.userId) {
    if (ticket.userId !== userId) throw missing();
    return { status: ticket.completedAt ? "completed" : "approved", agent_id: ticket.agentId };
  }
  if (Date.parse(ticket.grantExpiresAt) <= Date.now()) throw missing();
  const user = await ensureConsoleIdentity(userId), keys = consoleKeys(user);
  // Sign the exact string returned to the agent; JSON reserialization is unnecessary.
  const grant = JSON.stringify({ protocol: ONBOARDING_PROTOCOL, request_id: ticket.id, agent_urn: ticket.agentUrn,
    console_urn: keys.urn, methods: JSON.parse(ticket.methods), expires_at: ticket.grantExpiresAt });
  const signature = crypto.sign(null, Buffer.from(grant), keys.signingKey).toString("hex");
  const agent = await prisma.$transaction(async db => {
    const changed = await db.$executeRaw`UPDATE "OnboardingTicket" SET "userId" = ${userId}, "grant" = ${grant}, "signature" = ${signature}, "consolePublicKey" = ${keys.publicKey}
      WHERE "id" = ${ticket.id} AND "userId" IS NULL AND "ticketExpiresAt" > ${Date.now()}`;
    if (changed !== 1) throw new ControlError("这条申请已经处理，请重新读取。", 409);
    const agent = await db.agent.upsert({ where: { userId_urn: { userId, urn: ticket.agentUrn } }, update: { publicKey: ticket.agentPublicKey, platformRegistered: true },
      create: { userId, urn: ticket.agentUrn, name: ticket.name, publicKey: ticket.agentPublicKey, platformRegistered: true } });
    await db.$executeRaw`UPDATE "OnboardingTicket" SET "agentId" = ${agent.id} WHERE "id" = ${ticket.id}`;
    return agent;
  });
  return { status: "approved", agent_id: agent.id };
}
