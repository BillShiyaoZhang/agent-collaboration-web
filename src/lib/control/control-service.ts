import crypto from "crypto";
import type { User, Agent, ControlRequest } from "@prisma/client";
import { prisma } from "@/lib/shared/db";
import { CONTROL_PROTOCOL, validateControlResponse } from "@/lib/control/control-protocol";
import { ControlError, consoleKeys, encodeControl, decodeControl, verifyConsoleEnvelope, submitEnvelope, retrieveEnvelopes, acknowledgeEnvelopes } from "@/lib/control/control-transport";
import type { ControlPollTimings } from "@/lib/control/control-poll-metrics";
import { reserveWorkspaceSubmission, markWorkspaceSubmissionUncertain, clearWorkspaceSubmission, recordWorkspaceResponse } from "@/lib/workspace/workspace-store";

import { CONTROL_RETENTION_MS as RETENTION_MS, CONTROL_REQUEST_MS as REQUEST_MS, canonicalJSON } from "@agent-comm/client-contract";

export async function cleanupControlCache() {
  const now = new Date();
  const where = { expiresAt: { lte: now } };
  // A DELETE affecting zero rows still competes for SQLite's one write lock.
  if (await prisma.controlRequest.findFirst({ where, select: { id: true } }))
    await prisma.controlRequest.deleteMany({ where });
}

type CacheWorker = { stopped: boolean; timer?: ReturnType<typeof setTimeout>; warningAt: number };
const cacheGlobal = globalThis as typeof globalThis & { __agentControlCacheCleanup?: CacheWorker };
export function startControlCacheCleanup() {
  if (process.env.NEXT_PHASE === "phase-production-build" || cacheGlobal.__agentControlCacheCleanup && !cacheGlobal.__agentControlCacheCleanup.stopped) return;
  const state: CacheWorker = { stopped: false, warningAt: 0 };
  cacheGlobal.__agentControlCacheCleanup = state;
  const tick = async () => {
    if (state.stopped) return;
    try { await cleanupControlCache(); }
    catch {
      if (Date.now() - state.warningAt > 60_000) {
        console.warn("Control cache cleanup will retry; check database availability.");
        state.warningAt = Date.now();
      }
    } finally {
      if (!state.stopped) { state.timer = setTimeout(tick, 60_000); state.timer.unref?.(); }
    }
  };
  state.timer = setTimeout(tick, 60_000); state.timer.unref?.();
}

function expected(row: ControlRequest, agent: Agent) {
  return { request_id: row.id, agent_urn: agent.urn, console_urn: row.consoleUrn, deadline: row.deadline.toISOString(), method: row.method };
}

type Call = { request_id: string; method: string; params: Record<string, unknown> };
/** During the ten-minute cache transition, accept either original valid send key order.
 * Never re-encode ciphertext, extend deadlines, or omit an identity/content binding. */
function requestFingerprints(agent: Agent, consoleUrn: string, call: Call) {
  const values = [agent.id, consoleUrn, call.method, call.params];
  const digest = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
  const fingerprint = digest(canonicalJSON(values));
  const compatible = new Set([fingerprint, digest(JSON.stringify(values))]);
  const params = call.params;
  if (call.method === "conversation.send" && Object.keys(params).length === 2 &&
      typeof params.text === "string" && typeof params.conversation_id === "string") {
    for (const ordered of [{ text: params.text, conversation_id: params.conversation_id },
      { conversation_id: params.conversation_id, text: params.text }]) {
      compatible.add(digest(JSON.stringify([agent.id, consoleUrn, call.method, ordered])));
    }
  }
  const matches = (row: ControlRequest) => row.id === call.request_id && row.agentId === agent.id &&
    row.consoleUrn === consoleUrn && row.method === call.method && compatible.has(row.fingerprint);
  return { fingerprint, matches };
}

async function createControlCallOnce(user: User, agent: Agent, call: Call) {
  if (!user.virtualUrn) throw new ControlError("请先创建控制台身份，并在 agent 本机完成配对。", 409);
  const { fingerprint, matches } = requestFingerprints(agent, user.virtualUrn, call);
  let row = await prisma.controlRequest.findUnique({ where: { id: call.request_id } });
  if (row && !matches(row)) throw new ControlError("请求 ID 已绑定其他内容，请使用原请求重试。", 409);
  const reserve = call.method === "conversation.send" && !row?.responseEnvelope;
  if (reserve) await reserveWorkspaceSubmission(user, agent, call);
  let enqueueAttempted = false;
  try {
    if (!row) {
      if (await prisma.controlRequest.count({ where: { agent: { userId: user.id }, expiresAt: { gt: new Date() } } }) >= 64) throw new ControlError("短期请求数量达到上限，请稍后重试。", 429);
      const now = Date.now(), deadline = new Date(now + REQUEST_MS);
      const requestEnvelope = await encodeControl(user, { protocol: CONTROL_PROTOCOL, type: "request", ...expected({ id: call.request_id, consoleUrn: user.virtualUrn, method: call.method, deadline } as ControlRequest, agent), params: call.params });
      try {
        row = await prisma.controlRequest.create({ data: { id: call.request_id, agentId: agent.id, consoleUrn: user.virtualUrn,
          method: call.method, fingerprint, requestEnvelope, deadline, expiresAt: new Date(now + RETENTION_MS), createdAt: new Date(now) } });
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "P2002")) throw error;
        row = await prisma.controlRequest.findUnique({ where: { id: call.request_id } });
        if (!row || !matches(row)) throw new ControlError("请求 ID 冲突。", 409);
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
  const fingerprint = canonicalJSON([user.virtualUrn, call.method, call.params]);
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

async function measured<T>(timings: ControlPollTimings | undefined,
  phase: "mqRetrieveMs" | "responseDbMs" | "workspaceProjectionMs" | "acknowledgeMs",
  operation: () => Promise<T>): Promise<T> {
  if (!timings) return operation();
  const started = performance.now();
  try { return await operation(); }
  finally { timings[phase] = (timings[phase] || 0) + performance.now() - started; }
}

async function retrieveControlResponses(user: User, timings?: ControlPollTimings) {
  const items = await measured(timings, "mqRetrieveMs", () => retrieveEnvelopes(user, timings)), ack: string[] = [];
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
    const row = await measured(timings, "responseDbMs", () => prisma.controlRequest.findFirst({ where: { id: decoded.response.request_id, consoleUrn: user.virtualUrn!, agent: { userId: user.id } }, include: { agent: true } }));
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
        const saved = await measured(timings, "responseDbMs", () => prisma.controlRequest.updateMany({ where: { id: row.id, responseEnvelope: null }, data: { responseEnvelope: item.payload_proto, status: "complete" } }));
        if (!saved.count) {
          const accepted = await measured(timings, "responseDbMs", () => prisma.controlRequest.findUnique({ where: { id: row.id } }));
          if (!accepted || accepted.responseEnvelope !== item.payload_proto) { ack.push(item.message_id); continue; }
        }
      }
      await measured(timings, "workspaceProjectionMs", () => recordWorkspaceResponse(user, row.agent, row, decoded.response));
    }
    // A late, correctly correlated response can be discarded, but can never turn an expired call into success.
    ack.push(item.message_id);
  }
  await measured(timings, "acknowledgeMs", () => acknowledgeEnvelopes(user, ack));
}

const mailboxGlobal = globalThis as typeof globalThis & { __agentControlMailboxPolls?: Map<string, Promise<void>> };
export async function pollControlResponses(user: User, timings?: ControlPollTimings): Promise<void> {
  const polls = mailboxGlobal.__agentControlMailboxPolls ||= new Map();
  const previous = polls.get(user.id);
  if (previous) {
    if (timings) timings.sharedPoll = true;
    return previous;
  }
  const pending = retrieveControlResponses(user, timings);
  polls.set(user.id, pending);
  try { await pending; } finally { if (polls.get(user.id) === pending) polls.delete(user.id); }
}
