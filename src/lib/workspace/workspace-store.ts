import crypto from "crypto";
import { Prisma, type Agent, type ControlRequest, type User } from "@prisma/client";
import { prisma } from "@/lib/shared/db";
import { ControlError } from "@/lib/control/control-transport";
import { record, records, string, type RemoteRecord, type RpcMethod } from "@/lib/control/workbench-client";
import type { WorkspaceAgent, WorkspaceConnection, WorkspaceOverview, WorkspaceSubmission, WorkspaceSync } from "@/lib/workspace/workspace-types";

type DB = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;
type StateRow = { agentId: string; activeConversationId: string; activeSelectedAt: number; status: WorkspaceSync["status"];
  lastAttemptAt: number | null; lastSuccessAt: number | null; nextSyncAt: number; error: string | null;
  failures: number; requestId: string | null; plan: string | null; leaseToken: string | null; leaseUntil: number | null };
type SnapshotRow = { method: RpcMethod; recordKey: string; payload: string; sourceAt: number; savedAt: number; requestId: string };
type ItemRow = { itemId: string; payload: string; sourceAt: number; sortTime: number; status: string };
type SubmissionRow = { requestId: string; payload: string; phase: "sending" | "uncertain"; createdAt: number };
import { canonicalJSON, validateAttentionPage, attentionRequiresAction, notificationRoute, type AttentionItem, type NotificationPage, type WorkspaceNotification, type SyncPlanItem } from "@agent-comm/client-contract";
export type { SyncPlanItem } from "@agent-comm/client-contract";
export type SyncJob = Omit<StateRow, "activeConversationId" | "activeSelectedAt" | "plan"> & { plan: SyncPlanItem[] };

// Domain-separated key and authenticated record identity prevent ciphertext being
// copied between accounts, connections, snapshots or messages in the database.
function cryptKey() {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) throw new ControlError("服务器尚未配置工作空间加密。", 503);
  return crypto.createHmac("sha256", secret).update("agent-workspace/storage/v1").digest();
}
function seal(userId: string, agentId: string, kind: string, id: string, value: unknown): string {
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", cryptKey(), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify([userId, agentId, kind, id])));
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return ["v1", nonce.toString("base64"), cipher.getAuthTag().toString("base64"), bytes.toString("base64")].join(".");
}
function unseal<T>(userId: string, agentId: string, kind: string, id: string, payload: string): T {
  const [version, nonce, tag, data, extra] = payload.split(".");
  if (version !== "v1" || !nonce || !tag || !data || extra) throw new Error("Invalid workspace ciphertext");
  const decipher = crypto.createDecipheriv("aes-256-gcm", cryptKey(), Buffer.from(nonce, "base64"));
  decipher.setAAD(Buffer.from(JSON.stringify([userId, agentId, kind, id])));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8")) as T;
}
async function owned(userId: string, agentId: string) {
  return prisma.agent.findFirst({ where: { id: agentId, userId } });
}
async function ownerId(agentId: string) {
  const rows = await prisma.$queryRaw<{ userId: string }[]>`SELECT "userId" FROM "Agent" WHERE "id" = ${agentId}`;
  if (!rows[0]) throw new ControlError("连接不存在。", 404);
  return rows[0].userId;
}
async function state(db: DB, agentId: string) {
  await db.$executeRaw`INSERT OR IGNORE INTO "WorkspaceState" ("agentId") VALUES (${agentId})`;
}
export async function ensureWorkspaceState(agentId: string) { await state(prisma, agentId); }
function sync(row?: StateRow): WorkspaceSync {
  return { status: row?.status || "waiting", lastAttemptAt: row?.lastAttemptAt ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null, nextSyncAt: row?.nextSyncAt ?? null, error: row?.error ?? null };
}
function connection(agent: Agent, row?: StateRow): WorkspaceConnection {
  return { id: agent.id, name: agent.name, urn: agent.urn, platformRegistered: agent.platformRegistered,
    createdAt: agent.createdAt.toISOString(), lastActiveAt: agent.lastActiveAt?.toISOString() || null, sync: sync(row) };
}
function timestamp(value: unknown, fallback: number) {
  const parsed = typeof value === "number" ? (value < 1e12 ? value * 1000 : value) : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : fallback;
}
function decodeSubmission(userId: string, agentId: string, row?: SubmissionRow): WorkspaceSubmission | null {
  if (!row) return null;
  const retryable = row.createdAt + 120000 > Date.now();
  return { ...unseal<WorkspaceSubmission>(userId, agentId, "submission", row.requestId, row.payload), phase: retryable ? row.phase : "uncertain", retryable };
}

export async function getWorkspaceOverview(userId: string): Promise<WorkspaceOverview> {
  const agents = await prisma.agent.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
  const states = await prisma.$queryRaw<StateRow[]>`SELECT s.* FROM "WorkspaceState" s JOIN "Agent" a ON a."id" = s."agentId" WHERE a."userId" = ${userId}`;
  return { connections: agents.map(agent => connection(agent, states.find(row => row.agentId === agent.id))), notifications: await notificationCounts(prisma, userId) };
}

export async function getWorkspaceAgent(userId: string, agentId: string, conversationId?: string, before?: string): Promise<WorkspaceAgent | null> {
  const agent = await owned(userId, agentId);
  if (!agent) return null;
  const [user, stateRows, snapshotRows, submissionRows, conversationRows] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { virtualUrn: true, virtualEd25519PublicKey: true } }),
    prisma.$queryRaw<StateRow[]>`SELECT * FROM "WorkspaceState" WHERE "agentId" = ${agentId}`,
    prisma.$queryRaw<SnapshotRow[]>`SELECT * FROM "WorkspaceSnapshot" WHERE "agentId" = ${agentId}
      AND ("method" <> 'conversation.get' OR "recordKey" = COALESCE(${conversationId ?? null}, (SELECT "activeConversationId" FROM "WorkspaceState" WHERE "agentId" = ${agentId}), ''))
      ORDER BY "sourceAt" ASC`,
    prisma.$queryRaw<SubmissionRow[]>`SELECT * FROM "WorkspaceSubmission" WHERE "agentId" = ${agentId}`,
    prisma.$queryRaw<{ conversationId: string; payload: string; updatedAt: number; turnCount: bigint; pending: bigint }[]>`
      SELECT c.*, (SELECT COUNT(*) FROM "WorkspaceItem" i WHERE i."agentId" = c."agentId" AND i."kind" = 'turn' AND i."conversationId" = c."conversationId") AS "turnCount",
      (SELECT COUNT(*) FROM "WorkspaceItem" i WHERE i."agentId" = c."agentId" AND i."kind" = 'turn' AND i."conversationId" = c."conversationId" AND i."status" IN ('submitted','running')) AS "pending"
      FROM "WorkspaceConversation" c WHERE c."agentId" = ${agentId} ORDER BY c."updatedAt" DESC, c."conversationId" DESC LIMIT 50`,
  ]);
  const submission = decodeSubmission(userId, agentId, submissionRows[0]);
  const active = conversationId === undefined ? stateRows[0]?.activeConversationId || "" : conversationId;
  const snapshots: WorkspaceAgent["snapshots"] = {};
  for (const row of snapshotRows) {
    if (row.method === "conversation.get" && row.recordKey !== active) continue;
    snapshots[row.method] = { data: unseal(userId, agentId, `snapshot:${row.method}`, row.recordKey, row.payload), time: row.savedAt, sourceAt: row.sourceAt, requestId: row.requestId };
  }
  if (snapshots["inbox.list"]) {
    const inbox = await prisma.$queryRaw<ItemRow[]>`SELECT * FROM "WorkspaceItem" WHERE "agentId" = ${agentId} AND "kind" = 'inbox' ORDER BY "sortTime" DESC, "itemId" DESC LIMIT 100`;
    snapshots["inbox.list"].data.messages = inbox.reverse().map(row => unseal(userId, agentId, "inbox", row.itemId, row.payload));
  }
  let turns: ItemRow[] = [], hasEarlierTurns = false;
  if (active) {
    let cursor: ItemRow | undefined;
    if (before) {
      cursor = (await prisma.$queryRaw<ItemRow[]>`SELECT * FROM "WorkspaceItem" WHERE "agentId" = ${agentId} AND "kind" = 'turn' AND "conversationId" = ${active} AND "itemId" = ${before}`)[0];
      if (!cursor) throw new ControlError("对话分页位置不存在。", 400);
    }
    turns = await prisma.$queryRaw<ItemRow[]>(Prisma.sql`SELECT * FROM "WorkspaceItem" WHERE "agentId" = ${agentId} AND "kind" = 'turn' AND "conversationId" = ${active}
      ${cursor ? Prisma.sql`AND ("sortTime" < ${cursor.sortTime} OR ("sortTime" = ${cursor.sortTime} AND "itemId" < ${cursor.itemId}))` : Prisma.empty}
      ORDER BY "sortTime" DESC, "itemId" DESC LIMIT 101`);
    hasEarlierTurns = turns.length > 100;
    turns = turns.slice(0, 100).reverse();
  }
  const conversation = active ? { ...snapshots["conversation.get"]?.data, conversation_id: active,
    turns: turns.map(row => unseal<RemoteRecord>(userId, agentId, "turn", row.itemId, row.payload)) } : null;
  if (conversation && snapshots["conversation.get"]) snapshots["conversation.get"].data = conversation;
  return { agent: connection(agent, stateRows[0]), identity: { virtualUrn: user?.virtualUrn || null, virtualEd25519PublicKey: user?.virtualEd25519PublicKey || null },
    sync: sync(stateRows[0]), snapshots, conversations: conversationRows.map(row => ({ id: row.conversationId,
      title: string(unseal<RemoteRecord>(userId, agentId, "conversation", row.conversationId, row.payload).title, "新对话"),
      updatedAt: row.updatedAt, turnCount: Number(row.turnCount), pending: Number(row.pending) > 0 || submission?.conversationId === row.conversationId })),
    activeConversationId: active, conversation, hasEarlierTurns, submission };
}

export async function selectWorkspaceConversation(userId: string, agentId: string, conversationId: string | null) {
  if (!await owned(userId, agentId)) throw new ControlError("连接不存在。", 404);
  await prisma.$transaction(async tx => {
    if (conversationId) {
      const rows = await tx.$queryRaw<{ conversationId: string }[]>`SELECT "conversationId" FROM "WorkspaceConversation" WHERE "agentId" = ${agentId} AND "conversationId" = ${conversationId}`;
      if (!rows[0]) throw new ControlError("已保存的对话不存在。", 404);
    }
    await state(tx, agentId);
    await tx.$executeRaw`UPDATE "WorkspaceState" SET "activeConversationId" = ${conversationId || ""}, "activeSelectedAt" = ${Date.now()} WHERE "agentId" = ${agentId}`;
  });
}

async function saveSnapshot(db: DB, userId: string, agentId: string, row: ControlRequest, method: string, key: string, data: RemoteRecord) {
  const payload = seal(userId, agentId, `snapshot:${method}`, key, data), sourceAt = row.createdAt.getTime();
  await db.$executeRaw`INSERT INTO "WorkspaceSnapshot" ("agentId","method","recordKey","payload","sourceAt","savedAt","requestId")
    VALUES (${agentId},${method},${key},${payload},${sourceAt},${Date.now()},${row.id})
    ON CONFLICT("agentId","method","recordKey") DO UPDATE SET "payload" = excluded."payload", "sourceAt" = excluded."sourceAt", "savedAt" = excluded."savedAt", "requestId" = excluded."requestId"
    WHERE excluded."sourceAt" > "WorkspaceSnapshot"."sourceAt" OR (excluded."sourceAt" = "WorkspaceSnapshot"."sourceAt" AND excluded."requestId" > "WorkspaceSnapshot"."requestId")`;
}
async function saveItem(db: DB, userId: string, agentId: string, kind: "turn" | "inbox", id: string, conversationId: string, data: RemoteRecord, sourceAt: number) {
  const previous = (await db.$queryRaw<ItemRow[]>`SELECT * FROM "WorkspaceItem" WHERE "agentId" = ${agentId} AND "kind" = ${kind} AND "itemId" = ${id}`)[0];
  if (previous && previous.sourceAt > sourceAt) return;
  const prior = previous ? unseal<RemoteRecord>(userId, agentId, kind, id, previous.payload) : {};
  const merged = { ...prior, ...data };
  // A missing user-text field in a remote read must not erase the accepted send.
  if (!string(merged.text) && string(prior.text)) merged.text = prior.text;
  // Delayed or inconsistent remote snapshots cannot revive a settled turn.
  if (kind === "turn" && (["completed", "failed"].includes(string(prior.status)) || prior.status === "interrupted" && prior.locally_unconfirmed !== true) && ["submitted", "running"].includes(string(data.status))) {
    merged.status = prior.status; merged.response = prior.response; merged.error = prior.error;
  }
  const payload = seal(userId, agentId, kind, id, merged);
  const sortTime = previous?.sortTime ?? timestamp(data.created_at ?? data.received_at, sourceAt);
  const status = kind === "turn" && ["submitted", "running", "completed", "failed", "interrupted"].includes(string(merged.status)) ? string(merged.status) : "";
  await db.$executeRaw`INSERT INTO "WorkspaceItem" ("agentId","kind","itemId","conversationId","payload","sourceAt","sortTime","status")
    VALUES (${agentId},${kind},${id},${conversationId},${payload},${sourceAt},${sortTime},${status})
    ON CONFLICT("agentId","kind","itemId") DO UPDATE SET "payload" = excluded."payload", "sourceAt" = excluded."sourceAt", "status" = excluded."status"
    WHERE excluded."sourceAt" >= "WorkspaceItem"."sourceAt"`;
}
async function saveConversation(db: DB, userId: string, agentId: string, id: string, data: RemoteRecord, sourceAt: number, updatedAt: number) {
  const previous = (await db.$queryRaw<{ payload: string; sourceAt: number }[]>`SELECT "payload","sourceAt" FROM "WorkspaceConversation" WHERE "agentId" = ${agentId} AND "conversationId" = ${id}`)[0];
  const prior = previous ? unseal<RemoteRecord>(userId, agentId, "conversation", id, previous.payload) : {};
  const title = (prior.title !== "新对话" ? string(prior.title) : "") || string(data.title) || string(records(data.turns)[0]?.text).slice(0, 80) || "新对话";
  const payload = seal(userId, agentId, "conversation", id, { title });
  await db.$executeRaw`INSERT INTO "WorkspaceConversation" ("agentId","conversationId","payload","sourceAt","updatedAt") VALUES (${agentId},${id},${payload},${sourceAt},${updatedAt})
    ON CONFLICT("agentId","conversationId") DO UPDATE SET "payload" = excluded."payload", "sourceAt" = excluded."sourceAt", "updatedAt" = MAX("WorkspaceConversation"."updatedAt",excluded."updatedAt")
    WHERE excluded."sourceAt" >= "WorkspaceConversation"."sourceAt"`;
}

async function retryProjectionTransaction(write: () => Promise<void>) {
  const delays = [40, 120, 300];
  for (let attempt = 0; ; attempt++) {
    try { return await write(); }
    catch (error) {
      const details = record(error), metadata = record(details.meta);
      const busy = details.code === "SQLITE_BUSY" || details.code === "P2010" &&
        (metadata.code === "5" || metadata.code === 5 || metadata.code === "SQLITE_BUSY");
      if (!busy || attempt >= delays.length) throw error;
      // Retry only this rolled-back local transaction. Network delivery and
      // mailbox ACK remain outside, and every attempt reads current rows afresh.
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** Only call after envelope signature, sender, recipient and RPC correlation checks. */
export async function recordWorkspaceResponse(user: User, agent: Agent, row: ControlRequest, response: Record<string, unknown>) {
  if (agent.userId !== user.id || row.agentId !== agent.id || !await owned(user.id, agent.id)) throw new ControlError("连接不存在。", 404);
  await retryProjectionTransaction(() => prisma.$transaction(async tx => {
    await state(tx, agent.id);
    const pendingRow = (await tx.$queryRaw<SubmissionRow[]>`SELECT * FROM "WorkspaceSubmission" WHERE "agentId" = ${agent.id}`)[0];
    const pending = decodeSubmission(user.id, agent.id, pendingRow);
    const matchingPending = pendingRow?.requestId === row.id ? pending : null;
    const sourceAt = row.createdAt.getTime();
    if (Object.hasOwn(response, "error")) {
      if (row.method === "conversation.send" && matchingPending && pendingRow) {
        const rejectionMessages: Record<string, string> = {
          not_paired: "Agent 尚未完成配对，未受理这条消息。",
          owner_mismatch: "Agent 的配对身份不匹配，未受理这条消息。",
          method_not_allowed: "当前配对未开放发送权限，未受理这条消息。",
          unsupported_method: "Agent 暂不支持对话发送，未受理这条消息。",
          invalid_params: "Agent 未接受这条消息的请求参数。",
          queue_full: "Agent 当前待办队列已满，未受理这条消息。",
        };
        const code = string(record(response.error).code);
        const rejected = Object.hasOwn(rejectionMessages, code);
        const turn = { turn_id: matchingPending.turnId, text: matchingPending.text, created_at: pendingRow.createdAt / 1000,
          status: rejected ? "failed" : "interrupted", locally_unconfirmed: !rejected,
          error: rejected ? rejectionMessages[code] : "Agent 返回异常，尚不能确认这条消息是否已被处理，请先核实结果。" };
        await saveConversation(tx, user.id, agent.id, matchingPending.conversationId, { turns: [turn] }, sourceAt, pendingRow.createdAt);
        await saveItem(tx, user.id, agent.id, "turn", matchingPending.turnId, matchingPending.conversationId, turn, sourceAt);
        await tx.$executeRaw`UPDATE "WorkspaceState" SET "activeConversationId" = ${matchingPending.conversationId} WHERE "agentId" = ${agent.id} AND "activeSelectedAt" <= ${sourceAt}`;
        await tx.$executeRaw`DELETE FROM "WorkspaceSubmission" WHERE "agentId" = ${agent.id} AND "requestId" = ${row.id}`;
      }
      return;
    }
    const data = record(response.result), convId = string(data.conversation_id);
    if (row.method === "conversation.send") {
      const validId = (value: unknown) => typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value);
      const validReceipt = data.status === "submitted" && validId(data.conversation_id) && validId(data.turn_id) &&
        (!matchingPending || data.conversation_id === matchingPending.conversationId && data.turn_id === matchingPending.turnId);
      if (!validReceipt) {
        // An authenticated but incomplete receipt is not evidence of acceptance.
        await tx.$executeRaw`UPDATE "WorkspaceSubmission" SET "phase" = 'uncertain' WHERE "agentId" = ${agent.id} AND "requestId" = ${row.id}`;
        return;
      }
    }
    if (row.method === "attention.list") {
      const page = validateAttentionPage(data);
      const prior = (await tx.$queryRaw<SnapshotRow[]>`SELECT * FROM "WorkspaceSnapshot" WHERE "agentId" = ${agent.id} AND "method" = 'attention.list' AND "recordKey" = ''`)[0];
      const cursor = prior ? record(unseal(user.id, agent.id, "snapshot:attention.list", "", prior.payload)).cursor : 0;
      if (typeof cursor === "number" && page.cursor < cursor) return;
      const currentJob = (await tx.$queryRaw<StateRow[]>`SELECT * FROM "WorkspaceState" WHERE "agentId" = ${agent.id}`)[0];
      const currentPlan = currentJob?.plan ? unseal<SyncPlanItem[]>(user.id, agent.id, "sync", "plan", currentJob.plan) : [];
      const automaticPage = currentJob?.requestId === row.id && currentPlan[0]?.method === "attention.list" && Number(currentPlan[0].params.after || 0) <= Number(cursor);
      if (automaticPage && page.has_more && (!page.items.length || page.cursor <= Number(cursor))) throw new Error("Attention page does not advance");
      const initialized = await notificationBaseline(tx, agent.id, "attention");
      for (const item of page.items) await saveNotification(tx, user.id, agent.id, item, sourceAt, "attention", initialized);
      if (automaticPage && !page.has_more) {
        await finishNotificationBaseline(tx, agent.id, "attention");
        await tx.$executeRaw`UPDATE "WorkspaceNotification" SET "sourceAt" = MAX("sourceAt",${sourceAt}) WHERE "agentId" = ${agent.id} AND "remoteRevision" > 0`;
      }
      // Page facts and continuation are committed together. Replaying an older page cannot move the cursor backwards.
      // An explicit read with an arbitrary `after` must not skip the background worker's unseen history.
      if (automaticPage) await saveSnapshot(tx, user.id, agent.id, row, row.method, "", { schema: page.schema, cursor: page.cursor, has_more: page.has_more });
    } else {
      await saveSnapshot(tx, user.id, agent.id, row, row.method, row.method === "conversation.get" ? convId : "", data);
    }
    if (row.method === "contacts.add" || row.method === "approval.respond") {
      // The authenticated receipt schedules a new read; it never edits a contact
      // list or approval snapshot using browser input or a transport acknowledgement.
      await tx.$executeRaw`UPDATE "WorkspaceState" SET "nextSyncAt" = MIN("nextSyncAt",${Date.now()}) WHERE "agentId" = ${agent.id}`;
    }
    if (row.method === "contacts.list" || row.method === "collaboration.state") {
      if (Array.isArray(data.contacts)) await saveSnapshot(tx, user.id, agent.id, row, "contacts.list", "", { contacts: data.contacts });
    }
    if (row.method === "inbox.list" || row.method === "collaboration.state") {
      const inbox = row.method === "inbox.list" ? data : record(data.inbox);
      const messages = Array.isArray(data.messages) ? records(data.messages) : Array.isArray(data.inbox) ? records(data.inbox) : records(inbox.messages);
      if (row.method === "inbox.list" || Array.isArray(data.messages) || Array.isArray(data.inbox) || Array.isArray(inbox.messages)) {
        await saveSnapshot(tx, user.id, agent.id, row, "inbox.list", "", { ...inbox, messages: [] });
        for (const item of messages) {
          const id = string(item.message_id);
          if (id) await saveItem(tx, user.id, agent.id, "inbox", id, "", item, sourceAt);
        }
      }
    }
    if (row.method === "inbox.list" || row.method === "collaboration.state") await deriveNotificationSnapshot(tx, user.id, agent.id, row.method, data, sourceAt);
    if (row.method === "conversation.get" && convId) {
      const turns = records(data.turns);
      await saveConversation(tx, user.id, agent.id, convId, data, sourceAt,
        turns.length ? Math.max(...turns.map(turn => timestamp(turn.updated_at ?? turn.created_at, sourceAt))) : sourceAt);
      for (const turn of turns) {
        const id = string(turn.turn_id);
        if (id) await saveItem(tx, user.id, agent.id, "turn", id, convId, turn, sourceAt);
      }
      if (pending && pending.conversationId === convId && turns.some(turn => turn.turn_id === pending.turnId))
        await tx.$executeRaw`DELETE FROM "WorkspaceSubmission" WHERE "agentId" = ${agent.id} AND "requestId" = ${pending.call.request_id}`;
    }
    if (row.method === "conversation.send" && convId) {
      const turnId = string(data.turn_id), text = matchingPending?.text || "";
      const turn = { ...data, turn_id: turnId, text, created_at: sourceAt / 1000, status: "submitted" };
      await saveConversation(tx, user.id, agent.id, convId, { turns: [turn] }, sourceAt, sourceAt);
      if (turnId) await saveItem(tx, user.id, agent.id, "turn", turnId, convId, turn, sourceAt);
      await tx.$executeRaw`UPDATE "WorkspaceState" SET "activeConversationId" = ${convId} WHERE "agentId" = ${agent.id} AND "activeSelectedAt" <= ${sourceAt}`;
      await tx.$executeRaw`DELETE FROM "WorkspaceSubmission" WHERE "agentId" = ${agent.id} AND "requestId" = ${row.id}`;
    }
  }, { timeout: 20000 }));
}

export async function reserveWorkspaceSubmission(user: User, agent: Agent, call: { request_id: string; method: string; params: Record<string, unknown> }) {
  if (call.method !== "conversation.send") return;
  if (agent.userId !== user.id || !await owned(user.id, agent.id)) throw new ControlError("连接不存在。", 404);
  if (!user.virtualUrn) throw new ControlError("请先建立控制台身份。", 409);
  const value: WorkspaceSubmission = { call: { ...call, method: "conversation.send" }, text: string(call.params.text),
    conversationId: string(call.params.conversation_id, call.request_id),
    turnId: `turn-${crypto.createHash("sha256").update(`${user.virtualUrn}\0${call.request_id}`).digest("hex").slice(0, 40)}`,
    phase: "sending", retryable: false };
  const savedTurn = await prisma.$queryRaw<{ itemId: string }[]>`SELECT "itemId" FROM "WorkspaceItem" WHERE "agentId" = ${agent.id} AND "kind" = 'turn' AND "itemId" = ${value.turnId}`;
  if (savedTurn.length) throw new ControlError("这条消息已有保存记录，请查看原对话，避免重复投递。", 410);
  const payload = seal(user.id, agent.id, "submission", call.request_id, value);
  await prisma.$executeRaw`INSERT OR IGNORE INTO "WorkspaceSubmission" ("agentId","requestId","payload","createdAt") VALUES (${agent.id},${call.request_id},${payload},${Date.now()})`;
  const row = (await prisma.$queryRaw<SubmissionRow[]>`SELECT * FROM "WorkspaceSubmission" WHERE "agentId" = ${agent.id}`)[0];
  const existing = decodeSubmission(user.id, agent.id, row);
  if (!row || row.requestId !== call.request_id || (!existing || canonicalJSON(existing.call) !== canonicalJSON(value.call)))
    throw new ControlError("上一条消息的结果尚未确认，请先等待自动核实。", 409);
  if (row.createdAt + 120000 <= Date.now()) throw new ControlError("原消息投递期限已结束，正在自动核实处理结果。", 410);
}
export async function markWorkspaceSubmissionUncertain(agentId: string, requestId: string) {
  await prisma.$executeRaw`UPDATE "WorkspaceSubmission" SET "phase" = 'uncertain' WHERE "agentId" = ${agentId} AND "requestId" = ${requestId}`;
}
export async function clearWorkspaceSubmission(agentId: string, requestId: string) {
  // One SQLite statement holds the write lock while checking the durable wire
  // ledger. An encoding failure cannot erase another caller's queued request.
  await prisma.$executeRaw`DELETE FROM "WorkspaceSubmission" WHERE "agentId" = ${agentId} AND "requestId" = ${requestId}
    AND NOT EXISTS (SELECT 1 FROM "ControlRequest" WHERE "id" = ${requestId})`;
}

/** Explicitly release the composer while preserving an ambiguous write forever. */
export async function dismissWorkspaceSubmission(userId: string, agentId: string, requestId: string) {
  if (!await owned(userId, agentId)) throw new ControlError("连接不存在。", 404);
  await prisma.$transaction(async tx => {
    const row = (await tx.$queryRaw<SubmissionRow[]>`SELECT * FROM "WorkspaceSubmission" WHERE "agentId" = ${agentId} AND "requestId" = ${requestId}`)[0];
    if (!row) throw new ControlError("这条消息的待确认状态已更新。", 409);
    if (row.createdAt + 120000 > Date.now()) throw new ControlError("消息仍在等待受理回执，请稍后再继续。", 409);
    const pending = decodeSubmission(userId, agentId, row)!;
    const turn = { turn_id: pending.turnId, text: pending.text, status: "interrupted", locally_unconfirmed: true,
      error: "未能确认这条消息是否已被处理，请勿直接重复发送。", created_at: row.createdAt / 1000 };
    await saveConversation(tx, userId, agentId, pending.conversationId, { turns: [turn] }, row.createdAt, row.createdAt);
    await saveItem(tx, userId, agentId, "turn", pending.turnId, pending.conversationId, turn, row.createdAt);
    await tx.$executeRaw`DELETE FROM "WorkspaceSubmission" WHERE "agentId" = ${agentId} AND "requestId" = ${requestId}`;
  });
}

export async function readSyncJob(agentId: string): Promise<SyncJob> {
  const userId = await ownerId(agentId);
  await ensureWorkspaceState(agentId);
  const row = (await prisma.$queryRaw<StateRow[]>`SELECT * FROM "WorkspaceState" WHERE "agentId" = ${agentId}`)[0];
  return { agentId, ...sync(row), nextSyncAt: row.nextSyncAt, failures: row.failures, requestId: row.requestId,
    plan: row.plan ? unseal(userId, agentId, "sync", "plan", row.plan) : [], leaseToken: row.leaseToken, leaseUntil: row.leaseUntil };
}
export async function claimSyncJob(agentId: string, token: string, now: number, leaseMs: number): Promise<boolean> {
  await ensureWorkspaceState(agentId);
  return (await prisma.$executeRaw`UPDATE "WorkspaceState" SET "leaseToken" = ${token}, "leaseUntil" = ${now + leaseMs}
    WHERE "agentId" = ${agentId} AND "nextSyncAt" <= ${now} AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${now})`) > 0;
}
export async function updateSyncJob(agentId: string, patch: Partial<SyncJob>, leaseToken?: string): Promise<boolean> {
  const userId = await ownerId(agentId);
  await ensureWorkspaceState(agentId);
  const values: Prisma.Sql[] = [];
  const fields = ["status", "lastAttemptAt", "lastSuccessAt", "nextSyncAt", "error", "failures", "requestId", "leaseToken", "leaseUntil"] as const;
  for (const field of fields) if (patch[field] !== undefined) values.push(Prisma.sql`${Prisma.raw(`"${field}"`)} = ${patch[field]}`);
  if (patch.plan !== undefined) values.push(Prisma.sql`"plan" = ${seal(userId, agentId, "sync", "plan", patch.plan)}`);
  if (!values.length) return false;
  return (await prisma.$executeRaw(Prisma.sql`UPDATE "WorkspaceState" SET ${Prisma.join(values)} WHERE "agentId" = ${agentId}
    ${leaseToken === undefined ? Prisma.empty : Prisma.sql`AND "leaseToken" = ${leaseToken}`} `)) > 0;
}
export async function listDueSyncAgents(now: number, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ agentId: string }[]>`SELECT a."id" AS "agentId" FROM "Agent" a
    LEFT JOIN "WorkspaceState" s ON s."agentId" = a."id" WHERE (s."agentId" IS NULL OR s."nextSyncAt" <= ${now})
    AND (s."leaseUntil" IS NULL OR s."leaseUntil" <= ${now}) ORDER BY COALESCE(s."nextSyncAt",0), a."id" LIMIT ${Math.max(1, Math.min(100, limit))}`;
  return rows.map(row => row.agentId);
}
export async function scheduleWorkspaceSync(userId: string, agentId?: string) {
  const agents = await prisma.agent.findMany({ where: { userId, ...(agentId === undefined ? {} : { id: agentId }) }, select: { id: true } });
  if (agentId !== undefined && !agents.length) throw new ControlError("连接不存在。", 404);
  const now = Date.now();
  for (const agent of agents) {
    await ensureWorkspaceState(agent.id);
    await prisma.$executeRaw`UPDATE "WorkspaceState" SET "nextSyncAt" = MIN("nextSyncAt",${now}), "lastWakeAt" = ${now}
      WHERE "agentId" = ${agent.id} AND "lastWakeAt" <= ${now - 15000}`;
  }
}
export async function getTrackedConversationIds(userId: string, agentId: string): Promise<string[]> {
  if (!await owned(userId, agentId)) throw new ControlError("连接不存在。", 404);
  const states = await prisma.$queryRaw<StateRow[]>`SELECT * FROM "WorkspaceState" WHERE "agentId" = ${agentId}`;
  const submissions = await prisma.$queryRaw<SubmissionRow[]>`SELECT * FROM "WorkspaceSubmission" WHERE "agentId" = ${agentId}`;
  const pending = decodeSubmission(userId, agentId, submissions[0]);
  const rows = await prisma.$queryRaw<{ conversationId: string }[]>`SELECT "conversationId", MAX("sortTime") AS "updatedAt" FROM "WorkspaceItem"
    WHERE "agentId" = ${agentId} AND "kind" = 'turn' AND "status" IN ('submitted','running') GROUP BY "conversationId" ORDER BY "updatedAt" DESC LIMIT 5`;
  return Array.from(new Set([states[0]?.activeConversationId, pending?.conversationId, ...rows.map(row => row.conversationId)].filter((id): id is string => !!id))).slice(0, 5);
}

type NotificationRow = { seq: number | bigint; agentId: string; id: string; kind: string; state: AttentionItem["state"];
  revision: number; readRevision: number; remoteRevision: number; sourceAt: number; updatedAt: number; expiresAt: number | null; systemEligible: number; payload: string };
type NotificationPayload = { item: AttentionItem; source: "attention" | "snapshot" };
const notificationDigest = (value: unknown) => crypto.createHash("sha256").update(canonicalJSON(value)).digest("hex");
async function notificationBaseline(db: DB, agentId: string, kind: string): Promise<boolean> {
  return !!(await db.$queryRaw<{ complete: number }[]>`SELECT "complete" FROM "WorkspaceNotificationBaseline" WHERE "agentId" = ${agentId} AND "kind" = ${kind}`)[0]?.complete;
}
async function finishNotificationBaseline(db: DB, agentId: string, kind: string) {
  await db.$executeRaw`INSERT INTO "WorkspaceNotificationBaseline" ("agentId","kind","complete") VALUES (${agentId},${kind},1)
    ON CONFLICT("agentId","kind") DO UPDATE SET "complete" = 1`;
}
async function saveNotification(db: DB, userId: string, agentId: string, item: AttentionItem, sourceAt: number, source: NotificationPayload["source"], baselineComplete: boolean) {
  // Match a legacy projection to the feed's authoritative target without revealing IDs in storage keys.
  const id = notificationDigest(item.target.kind === "task" ? ["attention", item.attention_id] : [item.target.kind, item.target.id]);
  const previous = (await db.$queryRaw<NotificationRow[]>`SELECT * FROM "WorkspaceNotification" WHERE "agentId" = ${agentId} AND "id" = ${id}`)[0];
  if (previous && (source === "snapshot" && (previous.remoteRevision > 0 || previous.sourceAt > sourceAt) || source === "attention" && previous.remoteRevision >= item.revision)) return;
  const prior = previous ? unseal<NotificationPayload>(userId, agentId, "notification", id, previous.payload) : null;
  const meaningful = (value: AttentionItem) => ({ kind: value.kind, state: value.state, source_revision: value.source_revision, title: value.title, safe_summary: value.safe_summary, target: value.target, expires_at: value.expires_at ?? null });
  // Changing from fallback to feed does not itself create another unread item.
  const comparablePrior = prior && source === "attention" && prior.source === "snapshot" ? { ...prior.item, source_revision: item.source_revision } : prior?.item;
  const changed = !comparablePrior || canonicalJSON(meaningful(comparablePrior)) !== canonicalJSON(meaningful(item));
  const revision = previous ? previous.revision + Number(changed) : 1;
  let seq = previous ? Number(previous.seq) : 0;
  if (changed) {
    await db.$executeRaw`INSERT INTO "WorkspaceNotificationSequence" DEFAULT VALUES`;
    seq = Number((await db.$queryRaw<{ seq: bigint }[]>`SELECT MAX("seq") AS "seq" FROM "WorkspaceNotificationSequence"`)[0].seq);
    await db.$executeRaw`DELETE FROM "WorkspaceNotificationSequence" WHERE "seq" < ${seq}`;
  }
  const expiry = item.expires_at == null ? null : item.expires_at * 1000;
  const eligible = (baselineComplete || attentionRequiresAction(item.kind, item.state)) && (expiry === null || expiry > Date.now());
  const payload = seal(userId, agentId, "notification", id, { item, source });
  await db.$executeRaw`INSERT INTO "WorkspaceNotification" ("seq","agentId","id","kind","state","revision","remoteRevision","sourceAt","updatedAt","expiresAt","systemEligible","payload")
    VALUES (${seq},${agentId},${id},${item.kind},${item.state},${revision},${source === "attention" ? item.revision : 0},${sourceAt},${Date.now()},${expiry},${Number(eligible)},${payload})
    ON CONFLICT("agentId","id") DO UPDATE SET "seq" = excluded."seq", "kind" = excluded."kind", "state" = excluded."state", "revision" = excluded."revision",
    "remoteRevision" = excluded."remoteRevision", "sourceAt" = MAX("WorkspaceNotification"."sourceAt",excluded."sourceAt"),
    "updatedAt" = CASE WHEN excluded."revision" > "WorkspaceNotification"."revision" THEN excluded."updatedAt" ELSE "WorkspaceNotification"."updatedAt" END,
    "expiresAt" = excluded."expiresAt", "systemEligible" = CASE WHEN excluded."revision" > "WorkspaceNotification"."revision" THEN excluded."systemEligible" ELSE "WorkspaceNotification"."systemEligible" END, "payload" = excluded."payload"`;
}
async function deriveNotificationSnapshot(db: DB, userId: string, agentId: string, method: string, data: RemoteRecord, sourceAt: number) {
  const latest = (await db.$queryRaw<SnapshotRow[]>`SELECT * FROM "WorkspaceSnapshot" WHERE "agentId" = ${agentId} AND "method" = ${method} AND "recordKey" = ''`)[0];
  if (latest && latest.sourceAt > sourceAt) return;
  const capability = (await db.$queryRaw<SnapshotRow[]>`SELECT * FROM "WorkspaceSnapshot" WHERE "agentId" = ${agentId} AND "method" = 'capabilities' AND "recordKey" = ''`)[0];
  if (capability && records(record(unseal(userId, agentId, "snapshot:capabilities", "", capability.payload)).methods).some(item => item.name === "attention.list" && item.available === true)) return;
  const at = sourceAt / 1000;
  const inbox = record(data.inbox), messages = Array.isArray(data.messages) ? records(data.messages) : Array.isArray(data.inbox) ? records(data.inbox) : records(inbox.messages);
  const initialized = await notificationBaseline(db, agentId, "inbox");
  for (const message of messages) {
    const id = string(message.message_id); if (!id) continue;
    await saveNotification(db, userId, agentId, { attention_id: `inbox:${id}`, kind: "peer_message_received", subject_id: id, source_revision: 1, revision: 1,
      state: "open", title: "收到协作消息", safe_summary: "对端发来一条消息。请在收件箱查看并核实内容。", target: { kind: "inbox", id },
      created_at: timestamp(message.received_at, sourceAt) / 1000, updated_at: at }, sourceAt, "snapshot", initialized);
  }
  if (Array.isArray(data.messages) || Array.isArray(data.inbox) || Array.isArray(inbox.messages)) await finishNotificationBaseline(db, agentId, "inbox");
  if (method !== "collaboration.state") return;
  for (const approval of [...records(data.pending_confirmations), ...records(data.approval_decisions)]) {
    const id = string(approval.approval_id), status = string(approval.status);
    if (!id || !["pending", "presenting", "awaiting_approval", "approved", "denied", "expired", "superseded"].includes(status)) continue;
    if (["approved", "denied"].includes(status)) {
      // Compact historical decisions reconcile known reminders. Importing a
      // previously unseen completed decision must not create a new confirmation alert.
      const key = notificationDigest(["approval", id]);
      if (!(await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "WorkspaceNotification" WHERE "agentId" = ${agentId} AND "id" = ${key}`).length) continue;
    }
    const state: AttentionItem["state"] = ["approved", "denied"].includes(status) ? "resolved" : status === "superseded" ? "superseded" : "open";
    const operation = records(data.operations).concat(records(record(data.collaboration).operations)).find(item => item.operation_id === approval.subject_id);
    const taskId = approval.kind === "task" ? approval.subject_id : operation?.task_id;
    const task = records(data.tasks).find(item => item.task_id === taskId);
    // The approval's own expiry is a presentation lease: an expired card may be reopened.
    // Only a known underlying task deadline can expire the durable fallback reminder.
    const expiresAt = timestamp(record(task?.scope).expires_at, NaN);
    await saveNotification(db, userId, agentId, { attention_id: `approval:${id}`, kind: "owner_decision_required", subject_id: string(approval.subject_id, id),
      source_revision: notificationDigest([approval.question_version ?? approval.question_hash ?? approval.question ?? id]), revision: 1,
      state, title: "一项协作需要你确认", safe_summary: "请打开事项，核对当前问题和授权范围后作决定。", target: { kind: "approval", id },
      created_at: timestamp(approval.created_at, sourceAt) / 1000, updated_at: at, ...(Number.isFinite(expiresAt) ? { expires_at: expiresAt / 1000 } : {}) }, sourceAt, "snapshot", true);
  }
  // Absence from a bounded snapshot never resolves an earlier approval.
}
async function notificationCounts(db: DB, userId: string) {
  const rows = await db.$queryRaw<{ unread: bigint | null; pending: bigint | null }[]>`SELECT
    SUM(CASE WHEN n."readRevision" < n."revision" THEN 1 ELSE 0 END) AS "unread",
    SUM(CASE WHEN n."state" = 'open' AND n."kind" IN ('owner_decision_required','needs_recovery','connection_action_required','needs_response','new_collaboration_request') AND (n."expiresAt" IS NULL OR n."expiresAt" > ${Date.now()}) THEN 1 ELSE 0 END) AS "pending"
    FROM "WorkspaceNotification" n JOIN "Agent" a ON a."id" = n."agentId" WHERE a."userId" = ${userId}`;
  return { unread: Number(rows[0]?.unread || 0), pending: Number(rows[0]?.pending || 0) };
}
export async function getWorkspaceNotifications(userId: string, before?: number, filter: "all" | "unread" | "pending" = "all"): Promise<NotificationPage> {
  const rows = await prisma.$queryRaw<(NotificationRow & { agentName: string })[]>(Prisma.sql`SELECT n.*, a."name" AS "agentName" FROM "WorkspaceNotification" n JOIN "Agent" a ON a."id" = n."agentId"
    WHERE a."userId" = ${userId} ${before === undefined ? Prisma.empty : Prisma.sql`AND n."seq" < ${before}`}
    ${filter === "unread" ? Prisma.sql`AND n."readRevision" < n."revision"` : filter === "pending" ? Prisma.sql`AND n."state" = 'open' AND n."kind" IN ('owner_decision_required','needs_recovery','connection_action_required','needs_response','new_collaboration_request') AND (n."expiresAt" IS NULL OR n."expiresAt" > ${Date.now()})` : Prisma.empty}
    ORDER BY n."seq" DESC LIMIT 51`);
  const stateRows = await prisma.$queryRaw<(StateRow & { agentId: string })[]>`SELECT s.* FROM "WorkspaceState" s JOIN "Agent" a ON a."id" = s."agentId" WHERE a."userId" = ${userId}`;
  const items: WorkspaceNotification[] = rows.slice(0, 50).map(row => {
    const { item, source } = unseal<NotificationPayload>(userId, row.agentId, "notification", row.id, row.payload);
    const state = row.state === "open" && row.expiresAt !== null && row.expiresAt <= Date.now() ? "expired" : row.state;
    return { id: row.id, agentId: row.agentId, agentName: row.agentName, revision: row.revision, unread: row.readRevision < row.revision,
      requiresAction: attentionRequiresAction(row.kind, state), kind: row.kind, state, title: item.title, summary: item.safe_summary,
      target: item.target, href: notificationRoute(row.agentId, item.target), updatedAt: row.updatedAt, observedAt: row.sourceAt, expiresAt: row.expiresAt,
      systemEligible: !!row.systemEligible, source, sync: sync(stateRows.find(state => state.agentId === row.agentId)) };
  });
  return { items, ...await notificationCounts(prisma, userId), before: rows.length > 50 ? Number(rows[49].seq) : null, hasMore: rows.length > 50 };
}
export async function readWorkspaceNotification(userId: string, agentId: string, id: string, revision: number) {
  if (!await owned(userId, agentId)) throw new ControlError("提醒不存在。", 404);
  const row = (await prisma.$queryRaw<NotificationRow[]>`SELECT * FROM "WorkspaceNotification" WHERE "agentId" = ${agentId} AND "id" = ${id}`)[0];
  if (!row) throw new ControlError("提醒不存在。", 404);
  if (row.revision !== revision) throw new ControlError("提醒已经更新，请先查看新内容。", 409);
  const changed = await prisma.$executeRaw`UPDATE "WorkspaceNotification" SET "readRevision" = MAX("readRevision",${revision}) WHERE "agentId" = ${agentId} AND "id" = ${id} AND "revision" = ${revision}`;
  if (!changed) throw new ControlError("提醒已经更新，请先查看新内容。", 409);
}
export async function claimWorkspaceNotification(userId: string, agentId: string, id: string, revision: number, deviceId: string): Promise<boolean> {
  if (!await owned(userId, agentId)) throw new ControlError("提醒不存在。", 404);
  // A durable one-attempt claim prevents concurrent tabs and refreshes from displaying the same device notification.
  // A crashed claimant may lose a popup; the durable in-app item remains unread and is the recovery path.
  return (await prisma.$executeRaw`INSERT OR IGNORE INTO "WorkspaceNotificationDelivery" ("agentId","notificationId","revision","deviceId","claimedAt")
    SELECT n."agentId",n."id",n."revision",${deviceId},${Date.now()} FROM "WorkspaceNotification" n
    WHERE n."agentId" = ${agentId} AND n."id" = ${id} AND n."revision" = ${revision} AND n."readRevision" < n."revision" AND n."systemEligible" = 1
      AND n."state" = 'open' AND (n."expiresAt" IS NULL OR n."expiresAt" > ${Date.now()})`) > 0;
}
