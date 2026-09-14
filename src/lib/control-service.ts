import crypto from "crypto";
import type { User, Agent, ControlRequest } from "@prisma/client";
import { prisma } from "./db";
import { CONTROL_PROTOCOL, validateControlResponse } from "./control-protocol";
import { ControlError, consoleKeys, encodeControl, decodeControl, verifyConsoleEnvelope, submitEnvelope, retrieveEnvelopes, acknowledgeEnvelopes } from "./control-transport";
import { reserveWorkspaceSubmission, markWorkspaceSubmissionUncertain, clearWorkspaceSubmission, recordWorkspaceResponse } from "./workspace-store";

const RETENTION_MS = 10 * 60 * 1000;
const REQUEST_MS = 120 * 1000;

export async function cleanupControlCache() {
  await prisma.controlRequest.deleteMany({ where: { expiresAt: { lte: new Date() } } });
}

function expected(row: ControlRequest, agent: Agent) {
  return { request_id: row.id, agent_urn: agent.urn, console_urn: row.consoleUrn, deadline: row.deadline.toISOString(), method: row.method };
}

type Call = { request_id: string; method: string; params: Record<string, unknown> };
async function createControlCallOnce(user: User, agent: Agent, call: Call) {
  await cleanupControlCache();
  if (!user.virtualUrn) throw new ControlError("请先创建控制台身份，并在 agent 本机完成配对。", 409);
  const fingerprint = crypto.createHash("sha256").update(JSON.stringify([agent.id, user.virtualUrn, call.method, call.params])).digest("hex");
  let row = await prisma.controlRequest.findUnique({ where: { id: call.request_id } });
  if (row && (row.agentId !== agent.id || row.consoleUrn !== user.virtualUrn || row.fingerprint !== fingerprint)) throw new ControlError("请求 ID 已绑定其他内容，请使用原请求重试。", 409);
  const reserve = call.method === "conversation.send" && !row?.responseEnvelope;
  if (reserve) await reserveWorkspaceSubmission(user, agent, call);
  let enqueueAttempted = false;
  try {
    if (!row) {
      if (await prisma.controlRequest.count({ where: { agent: { userId: user.id } } }) >= 64) throw new ControlError("短期请求数量达到上限，请稍后重试。", 429);
      const now = Date.now(), deadline = new Date(now + REQUEST_MS);
      const requestEnvelope = await encodeControl(user, { protocol: CONTROL_PROTOCOL, type: "request", ...expected({ id: call.request_id, consoleUrn: user.virtualUrn, method: call.method, deadline } as ControlRequest, agent), params: call.params });
      try {
        row = await prisma.controlRequest.create({ data: { id: call.request_id, agentId: agent.id, consoleUrn: user.virtualUrn,
          method: call.method, fingerprint, requestEnvelope, deadline, expiresAt: new Date(now + RETENTION_MS), createdAt: new Date(now) } });
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
        row = await prisma.controlRequest.findUnique({ where: { id: call.request_id } });
        if (!row || row.agentId !== agent.id || row.consoleUrn !== user.virtualUrn || row.fingerprint !== fingerprint) throw new ControlError("请求 ID 冲突。", 409);
      }
    }
    if (row.status !== "complete") {
      if (row.deadline.getTime() <= Date.now()) throw new ControlError("请求已到期。请先从 agent 查询现状，再决定是否发起新动作。", 410);
      // A second process may have cleared an early reservation before this row existed.
      // Re-establish the durable write ledger after storing the wire call, before any enqueue.
      if (reserve) await reserveWorkspaceSubmission(user, agent, call);
      // Always retry the exact persisted ciphertext and message ID after uncertain network results.
      enqueueAttempted = true;
      await submitEnvelope(user, row.requestEnvelope, agent.urn, row.deadline);
    }
    const result = controlCallResult(user, agent, row);
    if ("response" in result && result.response) await recordWorkspaceResponse(user, agent, row, result.response);
    return result;
  } catch (error) {
    if (reserve) {
      if (enqueueAttempted || row) await markWorkspaceSubmissionUncertain(agent.id, call.request_id);
      else await clearWorkspaceSubmission(agent.id, call.request_id);
    }
    throw error;
  }
}

type InFlightCall = { fingerprint: string; promise: ReturnType<typeof createControlCallOnce> };
const callGlobal = globalThis as typeof globalThis & { __agentControlSubmissions?: Map<string, InFlightCall> };
export async function createControlCall(user: User, agent: Agent, call: Call) {
  const calls = callGlobal.__agentControlSubmissions ||= new Map();
  const key = JSON.stringify([user.id, agent.id, call.request_id]);
  const fingerprint = JSON.stringify([user.virtualUrn, call.method, call.params]);
  const previous = calls.get(key);
  if (previous) {
    if (previous.fingerprint !== fingerprint) throw new ControlError("请求 ID 已绑定其他内容，请使用原请求重试。", 409);
    return previous.promise;
  }
  const promise = createControlCallOnce(user, agent, call);
  calls.set(key, { fingerprint, promise });
  try { return await promise; } finally { if (calls.get(key)?.promise === promise) calls.delete(key); }
}

export function controlCallResult(user: User, agent: Agent, row: ControlRequest) {
  if (row.expiresAt.getTime() <= Date.now()) throw new ControlError("请求缓存已过期，请重新读取 agent 状态。", 410);
  if (row.responseEnvelope) {
    const decoded = decodeControl(user, row.responseEnvelope);
    if (decoded.envelope.senderUrn !== agent.urn) throw new Error("Unexpected cached sender");
    const response = validateControlResponse(decoded.response, expected(row, agent));
    return { request_id: row.id, status: "complete", response, expires_at: row.expiresAt.toISOString() };
  }
  return { request_id: row.id, status: row.deadline.getTime() <= Date.now() ? "expired" : "pending",
    deadline: row.deadline.toISOString(), message: "请求已入队，等待 agent 的认证响应。" };
}

async function retrieveControlResponses(user: User) {
  await cleanupControlCache();
  const items = await retrieveEnvelopes(user), ack: string[] = [];
  const keys = consoleKeys(user);
  for (const item of items) {
    // This identity is a dedicated console mailbox. Consume authenticated unrelated
    // traffic too, so old chat or peer junk cannot pin real responses behind it.
    try {
      if (verifyConsoleEnvelope(user, item.payload_proto).messageId !== item.message_id) continue;
    } catch { continue; }
    let decoded: ReturnType<typeof decodeControl>;
    try { decoded = decodeControl(user, item.payload_proto, keys); } catch { ack.push(item.message_id); continue; }
    if (typeof decoded.response?.request_id !== "string") { ack.push(item.message_id); continue; }
    const row = await prisma.controlRequest.findFirst({ where: { id: decoded.response.request_id, consoleUrn: user.virtualUrn!, agent: { userId: user.id } }, include: { agent: true } });
    if (!row || decoded.envelope.senderUrn !== row.agent.urn) { ack.push(item.message_id); continue; }
    try {
      validateControlResponse(decoded.response, expected(row, row.agent));
      if (decoded.chat.inReplyTo !== row.id || decoded.chat.deadline !== row.deadline.toISOString()) { ack.push(item.message_id); continue; }
    } catch { ack.push(item.message_id); continue; }
    if (row.responseEnvelope && row.responseEnvelope !== item.payload_proto) { ack.push(item.message_id); continue; }
    if (row.responseEnvelope || row.deadline.getTime() > Date.now()) {
      // Save both authenticated wire bytes and the account's durable projection before ACK.
      // Repeating the projection after an interrupted write is safe and keeps its original source ordering.
      if (!row.responseEnvelope) {
        const saved = await prisma.controlRequest.updateMany({ where: { id: row.id, responseEnvelope: null }, data: { responseEnvelope: item.payload_proto, status: "complete" } });
        if (!saved.count) {
          const accepted = await prisma.controlRequest.findUnique({ where: { id: row.id } });
          if (!accepted || accepted.responseEnvelope !== item.payload_proto) { ack.push(item.message_id); continue; }
        }
      }
      await recordWorkspaceResponse(user, row.agent, row, decoded.response);
    }
    // A late, correctly correlated response can be discarded, but can never turn an expired call into success.
    ack.push(item.message_id);
  }
  await acknowledgeEnvelopes(user, ack);
}

const mailboxGlobal = globalThis as typeof globalThis & { __agentControlMailboxPolls?: Map<string, Promise<void>> };
export async function pollControlResponses(user: User): Promise<void> {
  const polls = mailboxGlobal.__agentControlMailboxPolls ||= new Map();
  const previous = polls.get(user.id);
  if (previous) return previous;
  const pending = retrieveControlResponses(user);
  polls.set(user.id, pending);
  try { await pending; } finally { if (polls.get(user.id) === pending) polls.delete(user.id); }
}
