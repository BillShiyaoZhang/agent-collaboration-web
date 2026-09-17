import crypto from "crypto";
import type { Agent, ControlRequest, User } from "@prisma/client";
import { prisma } from "@/lib/shared/db";
import { ControlError, resolveIdentity } from "@/lib/control/control-transport";
import { createControlCall, pollControlResponses, controlCallResult } from "@/lib/control/control-service";
import { ensureWorkspaceState, listDueSyncAgents, claimSyncJob, readSyncJob, updateSyncJob,
  getWorkspaceAgent, getTrackedConversationIds, recordWorkspaceResponse, type SyncJob } from "@/lib/workspace/workspace-store";
import { AUTOMATIC_METHODS, SYNC_LEASE_MS, SYNC_INTERVAL_MS, syncReadPlan, syncBackoff, syncError, nextCycleDelay } from "@/lib/workspace/workspace-sync-policy";

type Worker = { timer?: ReturnType<typeof setTimeout>; running: boolean; lastDiscovery: number; stopped: boolean; lastWarning: number };
const workerGlobal = globalThis as typeof globalThis & { __agentWorkspaceSync?: Worker };

async function importRecentResults(user: User, agent: Agent) {
  // Import still-retained authenticated results from the previous browser-only release.
  const rows = await prisma.controlRequest.findMany({ where: { agentId: agent.id, consoleUrn: user.virtualUrn!, responseEnvelope: { not: null }, expiresAt: { gt: new Date() } }, orderBy: { createdAt: "asc" }, take: 64 });
  for (const row of rows) {
    try {
      const result = controlCallResult(user, agent, row);
      if ("response" in result && result.response) await recordWorkspaceResponse(user, agent, row, result.response);
    } catch (error) {
      if (!(error instanceof ControlError && error.status === 410)) throw error;
    }
  }
}

async function finishResponse(user: User, agent: Agent, job: SyncJob, token: string, row: ControlRequest) {
  const result = controlCallResult(user, agent, row);
  if (!("response" in result) || !result.response) return false;
  await recordWorkspaceResponse(user, agent, row, result.response);
  const failure = syncError(result.response);
  const now = Date.now();
  let advanced: boolean;
  if (failure?.pairing || (failure && row.method === "capabilities")) {
    advanced = await updateSyncJob(agent.id, { requestId: null, plan: [], status: failure.pairing ? "needs_pairing" : "offline",
      error: failure.message, failures: job.failures + 1, nextSyncAt: now + syncBackoff(job.failures + 1), leaseToken: null, leaseUntil: null }, token);
  } else {
    let plan = job.plan.slice(1);
    const workspace = await getWorkspaceAgent(user.id, agent.id);
    if (!workspace) return true;
    if (row.method === "capabilities" && !failure) {
      // The accepted capability result is now persisted; build only its permitted reads.
      workspace.sync.status = "ready";
      plan = syncReadPlan(workspace, await getTrackedConversationIds(user.id, agent.id), now);
      plan = plan.filter(item => item.method !== "capabilities");
    }
    advanced = await updateSyncJob(agent.id, { requestId: null, plan, status: plan.length ? "syncing" : "ready",
      ...(failure ? {} : { lastSuccessAt: now, failures: 0 }), error: failure?.message || null,
      nextSyncAt: plan.length ? now : now + nextCycleDelay(workspace), leaseToken: null, leaseUntil: null }, token);
  }
  // The durable projection may outlast our lease. Its successor still references
  // this exact request until it advances the plan, so only the CAS winner retires it.
  if (!advanced) return true;
  // This ID belongs exclusively to the automatic job and is never issued to a browser.
  // Its authenticated result is durable now; releasing it avoids the 64-request cache limit.
  await prisma.controlRequest.deleteMany({ where: { id: row.id, agentId: agent.id, status: "complete" } });
  return true;
}

export async function runAgentSyncStep(agentId: string): Promise<void> {
  const token = crypto.randomUUID(), now = Date.now();
  if (!await claimSyncJob(agentId, token, now, SYNC_LEASE_MS)) return;
  let job: SyncJob | undefined;
  try {
    job = await readSyncJob(agentId);
    const agent = await prisma.agent.findUnique({ where: { id: agentId }, include: { user: true } });
    if (!agent) return;
    const user = agent.user;
    if (!user.virtualUrn) {
      await updateSyncJob(agentId, { status: "needs_pairing", error: "请先创建控制台身份，再在 agent 本机配对。",
        nextSyncAt: now + 60_000, leaseToken: null, leaseUntil: null }, token);
      return;
    }
    if (agent.platformRegistered === false) {
      try {
        const identity = await resolveIdentity(agent.urn);
        const publicKey = Buffer.from(identity.ed25519_pubkey, "base64").toString("hex");
        await prisma.agent.update({ where: { id: agent.id }, data: { publicKey, platformRegistered: true } });
        agent.publicKey = publicKey; agent.platformRegistered = true;
      } catch (error) {
        if (!(error instanceof ControlError && error.platformStatus === 404)) throw error;
        await updateSyncJob(agentId, { status: "needs_pairing", error: "请在 agent 本机完成绑定设置；本机将自动注册到 platform。",
          nextSyncAt: Date.now() + 10_000, leaseToken: null, leaseUntil: null }, token);
        return;
      }
    }
    if (!job.lastSuccessAt && !job.requestId) await importRecentResults(user, agent);
    if (job.requestId) {
      let row = await prisma.controlRequest.findFirst({ where: { id: job.requestId, agentId, consoleUrn: user.virtualUrn } });
      if (row && (!AUTOMATIC_METHODS.has(row.method) || row.method !== job.plan[0]?.method)) {
        await updateSyncJob(agentId, { requestId: null, plan: [], status: "offline", error: "同步状态需要重新建立，已保存的内容保持不变。",
          nextSyncAt: Date.now() + SYNC_INTERVAL_MS, leaseToken: null, leaseUntil: null }, token);
        return;
      }
      if (row && !row.responseEnvelope && row.deadline.getTime() > Date.now()) {
        await pollControlResponses(user);
        row = await prisma.controlRequest.findUnique({ where: { id: job.requestId } });
      }
      if (row?.responseEnvelope && await finishResponse(user, agent, job, token, row)) return;
      if (row && row.deadline.getTime() <= Date.now()) {
        await prisma.controlRequest.deleteMany({ where: { id: row.id, agentId } });
        throw new ControlError("Automatic read expired", 410);
      }
      if (row) {
        await updateSyncJob(agentId, { nextSyncAt: Date.now() + 2_000, leaseToken: null, leaseUntil: null }, token);
        return;
      }
      // A process may have stopped after reserving the job ID but before storing its wire call.
      // Continue using the same ID and exact persisted read-only plan below.
    }
    if (!job.plan.length) {
      const workspace = await getWorkspaceAgent(user.id, agentId);
      if (!workspace) return;
      job.plan = syncReadPlan(workspace, await getTrackedConversationIds(user.id, agentId), Date.now());
      if (!job.plan.length) {
        await updateSyncJob(agentId, { status: "ready", nextSyncAt: Date.now() + SYNC_INTERVAL_MS, leaseToken: null, leaseUntil: null }, token);
        return;
      }
    }
    const next = job.plan[0];
    if (!AUTOMATIC_METHODS.has(next.method)) throw new Error("Automatic method is not read-only");
    const requestId = job.requestId || crypto.randomUUID();
    if (!await updateSyncJob(agentId, { plan: job.plan, requestId, status: "syncing", lastAttemptAt: Date.now() }, token)) return;
    job.requestId = requestId;
    await createControlCall(user, agent, { request_id: requestId, method: next.method, params: next.params });
    const row = await prisma.controlRequest.findUnique({ where: { id: requestId } });
    if (row?.responseEnvelope && await finishResponse(user, agent, job, token, row)) return;
    await updateSyncJob(agentId, { nextSyncAt: Date.now() + 2_000, leaseToken: null, leaseUntil: null }, token);
  } catch (error) {
    if (!job) return;
    // Poll ambiguous submissions by ID; an accepted response can keep retrying its
    // durable projection until cache expiry even after the original request deadline.
    const row = job.requestId ? await prisma.controlRequest.findFirst({ where: { id: job.requestId, agentId } }) : null;
    if (row && (row.responseEnvelope ? row.expiresAt : row.deadline).getTime() > Date.now()) {
      await updateSyncJob(agentId, { nextSyncAt: Date.now() + 5_000,
        error: row.responseEnvelope ? "已收到同步结果，正在重试保存。" : "连接暂时不稳定，正在等待本次同步结果。",
        leaseToken: null, leaseUntil: null }, token);
    } else {
      const failures = job.failures + 1;
      await updateSyncJob(agentId, { status: error instanceof ControlError && error.status === 409 ? "needs_pairing" : "offline",
        error: "暂时无法连接 agent，已保存的内容仍然可用，稍后会自动重试。", failures,
        requestId: null, plan: [], nextSyncAt: Date.now() + syncBackoff(failures), leaseToken: null, leaseUntil: null }, token);
    }
  }
}

export async function runWorkspaceSyncTick(): Promise<void> {
  const state = workerGlobal.__agentWorkspaceSync;
  const now = Date.now();
  if (!state || now - state.lastDiscovery >= 30_000) {
    const agents = await prisma.agent.findMany({ select: { id: true }, orderBy: { createdAt: "asc" } });
    for (const agent of agents) await ensureWorkspaceState(agent.id);
    if (state) state.lastDiscovery = now;
  }
  const due = await listDueSyncAgents(now, 4);
  // Two read-only jobs at most. Mailbox retrieval is single-flight per account.
  for (let offset = 0; offset < due.length; offset += 2) {
    const results = await Promise.allSettled(due.slice(offset, offset + 2).map(runAgentSyncStep));
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }
}

export function startWorkspaceSync() {
  if (process.env.WORKSPACE_SYNC_DISABLED === "1" || process.env.NEXT_PHASE === "phase-production-build") return;
  if (workerGlobal.__agentWorkspaceSync && !workerGlobal.__agentWorkspaceSync.stopped) return;
  const state: Worker = { running: false, lastDiscovery: 0, stopped: false, lastWarning: 0 };
  workerGlobal.__agentWorkspaceSync = state;
  const tick = async () => {
    if (state.stopped) return;
    state.running = true;
    try { await runWorkspaceSyncTick(); }
    catch {
      if (Date.now() - state.lastWarning > 60_000) {
        console.warn("Workspace background synchronization will retry; check database availability and migration.");
        state.lastWarning = Date.now();
      }
    } finally {
      state.running = false;
      if (!state.stopped) { state.timer = setTimeout(tick, 2_000); state.timer.unref?.(); }
    }
  };
  state.timer = setTimeout(tick, 100); state.timer.unref?.();
}

export function stopWorkspaceSync() {
  const state = workerGlobal.__agentWorkspaceSync;
  if (state) { state.stopped = true; clearTimeout(state.timer); }
}
