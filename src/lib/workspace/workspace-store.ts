import crypto from "crypto";
import { Prisma, type Agent, type ControlRequest, type User } from "@prisma/client";
import { prisma } from "@/lib/shared/db";
import { ControlError } from "@/lib/control/control-transport";
import { record, records, string, strings, type PendingCall, type RemoteRecord, type RpcMethod } from "@/lib/control/workbench-client";
import type { WorkspaceAgent, WorkspaceConnection, WorkspaceConversationPage, WorkspaceConversationState, WorkspaceOperation, WorkspaceOverview, WorkspaceRecordKind, WorkspaceRecordState, WorkspaceSubmission, WorkspaceSync } from "@/lib/workspace/workspace-types";

type DB = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;
type StateRow = { agentId: string; activeConversationId: string; activeSelectedAt: number; status: WorkspaceSync["status"];
  lastAttemptAt: number | null; lastSuccessAt: number | null; nextSyncAt: number; error: string | null;
  failures: number; requestId: string | null; plan: string | null; leaseToken: string | null; leaseUntil: number | null };
type SnapshotRow = { method: RpcMethod; recordKey: string; payload: string; sourceAt: number; savedAt: number; requestId: string };
type ItemRow = { itemId: string; payload: string; sourceAt: number; sortTime: number; status: string };
type SubmissionRow = { requestId: string; payload: string; phase: "sending" | "uncertain"; createdAt: number };
type OperationRow = { requestId: string; method: string; payload: string; phase: WorkspaceOperation["phase"]; createdAt: number; updatedAt: number };
type ConversationStateRow = { conversationId: string; payload: string; updatedAt: number };
const operationMethods = new Set(["contacts.add", "approval.respond", "contacts.respond", "messages.send", "inbox.mark_read", "collaboration.execute"]);
const emptyConversationState = (): WorkspaceConversationState => ({ archived: false, readAt: 0, draft: "", scrollTop: null });
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
function sqliteBusy(error: unknown) {
  const details = record(error), metadata = record(details.meta);
  return details.code === "SQLITE_BUSY" || details.code === "P2010" &&
    (metadata.code === "5" || metadata.code === 5 || metadata.code === "SQLITE_BUSY");
}
async function retryStandaloneSQLiteWrite<T>(write: () => Promise<T>): Promise<T> {
  // Only use for a single idempotent statement outside a transaction. Retrying
  // a whole sync step could repeat a network call after another agent advanced.
  const delays = [40, 120, 300];
  for (let attempt = 0; ; attempt++) {
    try { return await write(); }
    catch (error) {
      if (!sqliteBusy(error) || attempt >= delays.length) throw error;
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}
export async function ensureWorkspaceState(agentId: string) {
  // Discovery and reads call this repeatedly. Avoid a no-op INSERT write lock
  // after the row exists; the INSERT OR IGNORE still resolves creation races.
  if (!(await prisma.$queryRaw<{ agentId: string }[]>`SELECT "agentId" FROM "WorkspaceState" WHERE "agentId" = ${agentId}`).length)
    await retryStandaloneSQLiteWrite(() => state(prisma, agentId));
}
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
  let conversation = active ? { ...snapshots["conversation.get"]?.data, conversation_id: active,
    turns: turns.map(row => unseal<RemoteRecord>(userId, agentId, "turn", row.itemId, row.payload)) } : null;
  if (conversation && snapshots["conversation.get"]) snapshots["conversation.get"].data = conversation;
  const savedStates = await prisma.$queryRaw<ConversationStateRow[]>`SELECT * FROM "WorkspaceConversationState" WHERE "agentId" = ${agentId}`;
  const metadata = new Map(savedStates.map(row => [row.conversationId, unseal<WorkspaceConversationState>(userId, agentId, "conversation-state", row.conversationId, row.payload)]));
  if (metadata.get(active)?.deleted) {
    conversation = null;
    hasEarlierTurns = false;
    delete snapshots["conversation.get"];
  }
  return { agent: connection(agent, stateRows[0]), identity: { virtualUrn: user?.virtualUrn || null, virtualEd25519PublicKey: user?.virtualEd25519PublicKey || null },
    sync: sync(stateRows[0]), snapshots, conversations: conversationRows.map(row => {
      const saved = metadata.get(row.conversationId) || emptyConversationState();
      return { id: row.conversationId,
        title: saved.title || string(unseal<RemoteRecord>(userId, agentId, "conversation", row.conversationId, row.payload).title, "新对话"),
        deleted: saved.deleted === true, archived: saved.archived, readAt: saved.readAt, unread: row.updatedAt > saved.readAt,
        updatedAt: row.updatedAt, turnCount: Number(row.turnCount), pending: Number(row.pending) > 0 || submission?.conversationId === row.conversationId };
    }), activeConversationId: active, conversation, hasEarlierTurns, submission,
    operations: await getWorkspaceOperations(userId, agentId), recordStates: await getWorkspaceRecordStates(userId, agentId), activeConversationState: metadata.get(active) || emptyConversationState() };
}

export async function selectWorkspaceConversation(userId: string, agentId: string, conversationId: string | null) {
  if (!await owned(userId, agentId)) throw new ControlError("连接不存在。", 404);
  await prisma.$transaction(async tx => {
    if (conversationId) {
      const rows = await tx.$queryRaw<{ conversationId: string }[]>`SELECT "conversationId" FROM "WorkspaceConversation" WHERE "agentId" = ${agentId} AND "conversationId" = ${conversationId}`;
      if (!rows[0]) throw new ControlError("已保存的对话不存在。", 404);
      if ((await conversationState(tx, userId, agentId, conversationId)).deleted) throw new ControlError("请先恢复这段已删除的聊天。", 409);
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
  if (kind === "turn" && data.locally_unconfirmed !== true && ["submitted", "running", "completed", "failed", "interrupted"].includes(string(data.status))) merged.locally_unconfirmed = false;
  // A missing user-text field in a remote read must not erase the accepted send.
  if (!string(merged.text) && string(prior.text)) merged.text = prior.text;
  if (kind === "inbox" && prior.read === true) { merged.read = true; merged.read_at = prior.read_at; }
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
  const previous = (await db.$queryRaw<{ payload: string; sourceAt: number; updatedAt: number }[]>`SELECT "payload","sourceAt","updatedAt" FROM "WorkspaceConversation" WHERE "agentId" = ${agentId} AND "conversationId" = ${id}`)[0];
  if (previous && previous.sourceAt > sourceAt) return;
  const prior = previous ? unseal<RemoteRecord>(userId, agentId, "conversation", id, previous.payload) : {};
  if (previous) {
    let changed = false;
    const savedTurns = await db.$queryRaw<ItemRow[]>`SELECT * FROM "WorkspaceItem" WHERE "agentId" = ${agentId} AND "kind" = 'turn' AND "conversationId" = ${id}`;
    const saved = new Map(savedTurns.map(turn => [turn.itemId, turn]));
    for (const turn of records(data.turns)) {
      const row = saved.get(string(turn.turn_id));
      if (!row) { changed = true; break; }
      const old = unseal<RemoteRecord>(userId, agentId, "turn", row.itemId, row.payload);
      const regresses = ["completed", "failed"].includes(string(old.status)) && ["submitted", "running"].includes(string(turn.status));
      if (!regresses && ["status", "response", "error"].some(key => Object.hasOwn(turn, key) && canonicalJSON(turn[key] ?? null) !== canonicalJSON(old[key] ?? null))) { changed = true; break; }
    }
    // Observation time is meaningful only when owned turn facts actually change.
    // A background read cannot create another unread badge or reorder old history.
    updatedAt = changed ? Math.max(previous.updatedAt, updatedAt, sourceAt) : previous.updatedAt;
  }
  const title = (prior.title !== "新对话" ? string(prior.title) : "") || string(data.title) || string(records(data.turns)[0]?.text).slice(0, 80) || "新对话";
  const payload = seal(userId, agentId, "conversation", id, { title });
  await db.$executeRaw`INSERT INTO "WorkspaceConversation" ("agentId","conversationId","payload","sourceAt","updatedAt") VALUES (${agentId},${id},${payload},${sourceAt},${updatedAt})
    ON CONFLICT("agentId","conversationId") DO UPDATE SET "payload" = excluded."payload", "sourceAt" = excluded."sourceAt", "updatedAt" = MAX("WorkspaceConversation"."updatedAt",excluded."updatedAt")
    WHERE excluded."sourceAt" >= "WorkspaceConversation"."sourceAt"`;
}

async function retryProjectionTransaction(write: (onEnter: () => void) => Promise<void>) {
  const delays = [40, 120, 300];
  for (let attempt = 0; ; attempt++) {
    let entered = false;
    try { return await write(() => { entered = true; }); }
    catch (error) {
      const busy = sqliteBusy(error);
      const details = record(error);
      // Prisma may report a busy SQLite writer as P1008 while opening a
      // transaction. No application statement ran if the callback never began.
      const startTimeout = details.code === "P1008" && !entered;
      if ((!busy && !startTimeout) || attempt >= delays.length) throw error;
      // Retry only this rolled-back local transaction. Network delivery and
      // mailbox ACK remain outside, and every attempt reads current rows afresh.
      await new Promise(resolve => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** Only call after envelope signature, sender, recipient and RPC correlation checks. */
export async function recordWorkspaceResponse(user: User, agent: Agent, row: ControlRequest, response: Record<string, unknown>) {
  if (agent.userId !== user.id || row.agentId !== agent.id || !await owned(user.id, agent.id)) throw new ControlError("连接不存在。", 404);
  await retryProjectionTransaction(onEnter => prisma.$transaction(async tx => {
    onEnter();
    await state(tx, agent.id);
    const pendingRow = (await tx.$queryRaw<SubmissionRow[]>`SELECT * FROM "WorkspaceSubmission" WHERE "agentId" = ${agent.id}`)[0];
    const pending = decodeSubmission(user.id, agent.id, pendingRow);
    const matchingPending = pendingRow?.requestId === row.id ? pending : null;
    const sourceAt = row.createdAt.getTime();
    await settleWorkspaceOperation(tx, user.id, agent.id, row, response);
    if (!Object.hasOwn(response, "error")) await reconcileWorkspaceOperations(tx, user.id, agent.id, row.method, record(response.result));
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
      for (const item of page.items) {
        await saveNotification(tx, user.id, agent.id, item, sourceAt, "attention", initialized);
        if (item.target.kind === "inbox" && item.state === "resolved" && ["peer_message_received", "friend_request_accepted", "friend_request_rejected"].includes(item.kind)) {
          // Resolved inbox attention is the agent's read fact, including old messages outside its latest inbox window.
          const previous = (await tx.$queryRaw<ItemRow[]>`SELECT * FROM "WorkspaceItem" WHERE "agentId"=${agent.id} AND "kind"='inbox' AND "itemId"=${item.target.id}`)[0];
          if (previous) await saveItem(tx, user.id, agent.id, "inbox", item.target.id, "", { ...unseal<RemoteRecord>(user.id, agent.id, "inbox", item.target.id, previous.payload), read: true, read_at: item.updated_at }, Math.max(sourceAt, previous.sourceAt));
        }
      }
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
    if (row.method === "inbox.mark_read" && data.status === "read" && record(data.message).message_id === data.message_id && record(data.message).read === true) {
      await saveItem(tx, user.id, agent.id, "inbox", string(data.message_id), "", record(data.message), sourceAt);
    }
    if (["contacts.add", "approval.respond", "contacts.respond", "messages.send", "inbox.mark_read", "collaboration.execute"].includes(row.method)) {
      // The authenticated receipt schedules a new read; it never edits a contact
      // list or approval snapshot using browser input or a transport acknowledgement.
      await tx.$executeRaw`UPDATE "WorkspaceState" SET "nextSyncAt" = MIN("nextSyncAt",${Date.now()}) WHERE "agentId" = ${agent.id}`;
    }
    if (row.method === "contacts.list" || row.method === "collaboration.state") {
      if (Array.isArray(data.contacts)) await saveSnapshot(tx, user.id, agent.id, row, "contacts.list", "", { contacts: data.contacts });
    }
    if (row.method === "collaboration.state" && Array.isArray(data.contact_requests))
      await saveSnapshot(tx, user.id, agent.id, row, "contacts.requests", "", { contact_requests: data.contact_requests });
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
      await deriveConversationNotifications(tx, user.id, agent.id, convId, turns, sourceAt);
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
  await prisma.$transaction(async tx => {
    await requireOwnedRecord(tx, user.id, agent.id);
    if ((await conversationState(tx, user.id, agent.id, value.conversationId)).deleted)
      throw new ControlError("请先恢复已删除的聊天，再发送新消息。", 409);
    await tx.$executeRaw`INSERT OR IGNORE INTO "WorkspaceSubmission" ("agentId","requestId","payload","createdAt") VALUES (${agent.id},${call.request_id},${payload},${Date.now()})`;
  });
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
  return (await retryStandaloneSQLiteWrite(() => prisma.$executeRaw`UPDATE "WorkspaceState" SET "leaseToken" = ${token}, "leaseUntil" = ${now + leaseMs}
    WHERE "agentId" = ${agentId} AND "nextSyncAt" <= ${now} AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${now})`)) > 0;
}
export async function updateSyncJob(agentId: string, patch: Partial<SyncJob>, leaseToken?: string): Promise<boolean> {
  const userId = await ownerId(agentId);
  await ensureWorkspaceState(agentId);
  const values: Prisma.Sql[] = [];
  const fields = ["status", "lastAttemptAt", "lastSuccessAt", "nextSyncAt", "error", "failures", "requestId", "leaseToken", "leaseUntil"] as const;
  for (const field of fields) if (patch[field] !== undefined) values.push(Prisma.sql`${Prisma.raw(`"${field}"`)} = ${patch[field]}`);
  if (patch.plan !== undefined) values.push(Prisma.sql`"plan" = ${seal(userId, agentId, "sync", "plan", patch.plan)}`);
  if (!values.length) return false;
  return (await retryStandaloneSQLiteWrite(() => prisma.$executeRaw(Prisma.sql`UPDATE "WorkspaceState" SET ${Prisma.join(values)} WHERE "agentId" = ${agentId}
    ${leaseToken === undefined ? Prisma.empty : Prisma.sql`AND "leaseToken" = ${leaseToken}`} `))) > 0;
}
export async function listDueSyncAgents(now: number, limit: number): Promise<string[]> {
  const rows = await prisma.$queryRaw<{ agentId: string }[]>`SELECT a."id" AS "agentId" FROM "Agent" a
    LEFT JOIN "WorkspaceState" s ON s."agentId" = a."id" WHERE (s."agentId" IS NULL OR s."nextSyncAt" <= ${now})
    AND (s."leaseUntil" IS NULL OR s."leaseUntil" <= ${now}) ORDER BY COALESCE(s."nextSyncAt",0), a."id" LIMIT ${Math.max(1, Math.min(100, limit))}`;
  return rows.map(row => row.agentId);
}
export async function scheduleWorkspaceSync(userId: string, agentId?: string, force = false) {
  const agents = await prisma.agent.findMany({ where: { userId, ...(agentId === undefined ? {} : { id: agentId }) }, select: { id: true } });
  if (agentId !== undefined && !agents.length) throw new ControlError("连接不存在。", 404);
  const now = Date.now();
  for (const agent of agents) {
    await ensureWorkspaceState(agent.id);
    await retryStandaloneSQLiteWrite(() => prisma.$executeRaw(Prisma.sql`UPDATE "WorkspaceState" SET "nextSyncAt" = MIN("nextSyncAt",${now}), "lastWakeAt" = ${now}
      WHERE "agentId" = ${agent.id} ${force ? Prisma.empty : Prisma.sql`AND "lastWakeAt" <= ${now - 15000}`}`));
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
  const id = notificationDigest(item.target.kind === "task" ? ["attention", item.attention_id] : item.target.kind === "conversation"
    ? ["conversation", item.target.id, item.target.turn_id || ""] : [item.target.kind, item.target.id]);
  const previous = (await db.$queryRaw<NotificationRow[]>`SELECT * FROM "WorkspaceNotification" WHERE "agentId" = ${agentId} AND "id" = ${id}`)[0];
  if (previous && (source === "snapshot" && (previous.remoteRevision > 0 || previous.sourceAt > sourceAt) || source === "attention" && previous.remoteRevision >= item.revision)) return;
  const prior = previous ? unseal<NotificationPayload>(userId, agentId, "notification", id, previous.payload) : null;
  const meaningful = (value: AttentionItem) => ({ kind: value.kind, state: value.state, source_revision: value.source_revision, title: value.title, safe_summary: value.safe_summary, target: value.target, expires_at: value.expires_at ?? null });
  // Changing from fallback to feed does not itself create another unread item.
  const comparablePrior = prior && source === "attention" && prior.source === "snapshot" ? { ...prior.item, source_revision: item.source_revision } : prior?.item;
  const changed = !comparablePrior || (item.target.kind === "conversation" && prior?.source === "snapshot" && source === "attention"
    ? comparablePrior.kind !== item.kind || comparablePrior.state !== item.state
    : canonicalJSON(meaningful(comparablePrior)) !== canonicalJSON(meaningful(item)));
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
  if (item.target.kind === "conversation") {
    const saved = await conversationState(db, userId, agentId, item.target.id);
    if (saved.readAt >= item.updated_at * 1000) await db.$executeRaw`UPDATE "WorkspaceNotification" SET "readRevision" = "revision" WHERE "agentId" = ${agentId} AND "id" = ${id}`;
  }
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
      state: message.read === true ? "resolved" : "open", title: "收到协作消息", safe_summary: "对端发来一条消息。请在收件箱查看并核实内容。", target: { kind: "inbox", id },
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
    SUM(CASE WHEN n."state" = 'open' AND n."readRevision" < n."revision" THEN 1 ELSE 0 END) AS "unread",
    SUM(CASE WHEN n."state" = 'open' AND n."kind" IN ('owner_decision_required','needs_recovery','connection_action_required','needs_response','new_collaboration_request','friend_request_received') AND (n."expiresAt" IS NULL OR n."expiresAt" > ${Date.now()}) THEN 1 ELSE 0 END) AS "pending"
    FROM "WorkspaceNotification" n JOIN "Agent" a ON a."id" = n."agentId" WHERE a."userId" = ${userId}`;
  return { unread: Number(rows[0]?.unread || 0), pending: Number(rows[0]?.pending || 0) };
}
export async function getWorkspaceNotifications(userId: string, before?: number, filter: "all" | "unread" | "pending" = "all"): Promise<NotificationPage> {
  const rows = await prisma.$queryRaw<(NotificationRow & { agentName: string })[]>(Prisma.sql`SELECT n.*, a."name" AS "agentName" FROM "WorkspaceNotification" n JOIN "Agent" a ON a."id" = n."agentId"
    WHERE a."userId" = ${userId} ${before === undefined ? Prisma.empty : Prisma.sql`AND n."seq" < ${before}`}
    ${filter === "unread" ? Prisma.sql`AND n."state" = 'open' AND n."readRevision" < n."revision"` : filter === "pending" ? Prisma.sql`AND n."state" = 'open' AND n."kind" IN ('owner_decision_required','needs_recovery','connection_action_required','needs_response','new_collaboration_request','friend_request_received') AND (n."expiresAt" IS NULL OR n."expiresAt" > ${Date.now()})` : Prisma.empty}
    ORDER BY n."seq" DESC LIMIT 51`);
  const stateRows = await prisma.$queryRaw<(StateRow & { agentId: string })[]>`SELECT s.* FROM "WorkspaceState" s JOIN "Agent" a ON a."id" = s."agentId" WHERE a."userId" = ${userId}`;
  const items: WorkspaceNotification[] = rows.slice(0, 50).map(row => {
    const { item, source } = unseal<NotificationPayload>(userId, row.agentId, "notification", row.id, row.payload);
    const state = row.state === "open" && row.expiresAt !== null && row.expiresAt <= Date.now() ? "expired" : row.state;
    return { id: row.id, agentId: row.agentId, agentName: row.agentName, revision: row.revision, unread: state === "open" && row.readRevision < row.revision,
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

function decodeOperation(userId: string, agentId: string, row: OperationRow): WorkspaceOperation {
  const saved = unseal<WorkspaceOperation>(userId, agentId, "operation", row.requestId, row.payload);
  const unresolved = ["sending", "uncertain"].includes(row.phase);
  return { ...saved, createdAt: row.createdAt, updatedAt: row.updatedAt,
    phase: unresolved && row.createdAt + 120000 <= Date.now() ? "uncertain" : row.phase,
    retryable: unresolved && saved.retryable !== false && row.createdAt + 120000 > Date.now() };
}
export async function getWorkspaceOperations(userId: string, agentId: string): Promise<WorkspaceOperation[]> {
  if (!await owned(userId, agentId)) throw new ControlError("连接不存在。", 404);
  const rows = await prisma.$queryRaw<OperationRow[]>`SELECT * FROM "WorkspaceOperation" WHERE "agentId" = ${agentId}
    AND ("phase" IN ('sending','uncertain') OR "requestId" IN (SELECT "requestId" FROM "WorkspaceOperation" WHERE "agentId" = ${agentId} ORDER BY "updatedAt" DESC, "requestId" DESC LIMIT 100))
    ORDER BY CASE WHEN "phase" IN ('sending','uncertain') THEN 0 ELSE 1 END, "updatedAt" DESC, "requestId" DESC`;
  // Historical describe rows remain in encrypted audit storage, but a read
  // cannot be restored as a pending business effect or lock real writes.
  return rows.map(row => decodeOperation(userId, agentId, row)).filter(operation =>
    !(operation.call.method === "collaboration.execute" && operation.call.params.action === "describe"));
}

/** Persist exact parameters before any encoding or delivery; never extend a replay window. */
export async function reserveWorkspaceOperation(userId: string, agentId: string, call: PendingCall,
  presentation: { reusedContact?: boolean; conversationId?: string; legacy?: boolean } = {}): Promise<WorkspaceOperation | null> {
  if (!operationMethods.has(call.method) || call.method === "collaboration.execute" && call.params.action === "describe") return null;
  if (!await owned(userId, agentId)) throw new ControlError("连接不存在。", 404);
  const now = Date.now(), createdAt = presentation.legacy ? now - 120001 : now;
  const value: WorkspaceOperation = { call, phase: presentation.legacy ? "uncertain" : "sending", retryable: !presentation.legacy,
    message: presentation.legacy ? "已恢复旧浏览器中的原操作。原投递期限未知，请先核实，不能重新投递。" : "正在提交，等待 agent 确认…",
    createdAt, updatedAt: now, reusedContact: presentation.reusedContact, conversationId: presentation.conversationId };
  const payload = seal(userId, agentId, "operation", call.request_id, value);
  await prisma.$transaction(async tx => {
    await requireOwnedRecord(tx, userId, agentId);
    if (!presentation.legacy) await requireVisibleOperationTarget(tx, userId, agentId, call);
    await tx.$executeRaw`INSERT OR IGNORE INTO "WorkspaceOperation" ("agentId","requestId","method","phase","payload","createdAt","updatedAt")
      VALUES (${agentId},${call.request_id},${call.method},${value.phase},${payload},${createdAt},${now})`;
  });
  const row = (await prisma.$queryRaw<OperationRow[]>`SELECT * FROM "WorkspaceOperation" WHERE "agentId" = ${agentId} AND "requestId" = ${call.request_id}`)[0];
  const existing = row && decodeOperation(userId, agentId, row);
  if (!existing || canonicalJSON(existing.call) !== canonicalJSON(call))
    throw new ControlError("请求 ID 已绑定原操作，请保留原 ID 和内容进行核实。", 409);
  if (!presentation.legacy && (row.createdAt + 120000 <= now || ["succeeded", "failed"].includes(row.phase)))
    throw new ControlError("原操作投递期限已结束。请查询原对象或在本机核实；不会重新投递。", 410);
  return existing;
}

/** Browser status is a conservative presentation hint, never an authenticated result. */
export async function updateWorkspaceOperation(userId: string, agentId: string, requestId: string,
  patch: { phase: "sending" | "uncertain" | "failed" | "succeeded"; message?: string; retryable?: boolean }): Promise<WorkspaceOperation> {
  if (!await owned(userId, agentId)) throw new ControlError("连接不存在。", 404);
  return prisma.$transaction(async tx => {
    const row = (await tx.$queryRaw<OperationRow[]>`SELECT * FROM "WorkspaceOperation" WHERE "agentId" = ${agentId} AND "requestId" = ${requestId}`)[0];
    if (!row) throw new ControlError("原操作记录不存在。", 404);
    const existing = decodeOperation(userId, agentId, row);
    // Only agent responses and authenticated snapshots settle business facts.
    if (!["sending", "uncertain"].includes(row.phase)) return existing;
    const value = { ...existing, phase: "uncertain" as const,
      message: patch.message || "上次提交的结果尚未核实。请查看原对象的最新状态。",
      retryable: existing.retryable && patch.retryable !== false, updatedAt: Date.now() };
    await tx.$executeRaw`UPDATE "WorkspaceOperation" SET "phase" = 'uncertain', "payload" = ${seal(userId, agentId, "operation", requestId, value)}, "updatedAt" = ${value.updatedAt}
      WHERE "agentId" = ${agentId} AND "requestId" = ${requestId}`;
    return value;
  });
}

/** Transport failures remain uncertain once durable wire bytes may have been queued. */
export async function markWorkspaceOperationTransportFailure(userId: string, agentId: string, requestId: string, mayHaveSent: boolean) {
  const rows = await prisma.$queryRaw<OperationRow[]>`SELECT * FROM "WorkspaceOperation" WHERE "agentId" = ${agentId} AND "requestId" = ${requestId}`;
  if (!rows[0] || !["sending", "uncertain"].includes(rows[0].phase)) return;
  const value = decodeOperation(userId, agentId, rows[0]);
  value.phase = mayHaveSent ? "uncertain" : "failed";
  value.retryable = mayHaveSent && value.retryable;
  value.message = mayHaveSent ? "提交结果尚未核实。请查看原对象状态；原请求和参数已保留。" : "操作尚未投递。原请求和参数已保留。";
  value.updatedAt = Date.now();
  await retryStandaloneSQLiteWrite(() => prisma.$executeRaw`UPDATE "WorkspaceOperation" SET "phase" = ${value.phase}, "payload" = ${seal(userId, agentId, "operation", requestId, value)}, "updatedAt" = ${value.updatedAt}
    WHERE "agentId" = ${agentId} AND "requestId" = ${requestId} AND "phase" IN ('sending','uncertain')`);
}

async function settleWorkspaceOperation(db: DB, userId: string, agentId: string, row: ControlRequest, response: RemoteRecord) {
  if (!operationMethods.has(row.method)) return;
  const saved = (await db.$queryRaw<OperationRow[]>`SELECT * FROM "WorkspaceOperation" WHERE "agentId" = ${agentId} AND "requestId" = ${row.id}`)[0];
  if (!saved || !["sending", "uncertain"].includes(saved.phase)) return;
  const operation = decodeOperation(userId, agentId, saved), data = record(response.result), params = operation.call.params;
  const errorCode = string(record(response.error).code);
  const rejected = Object.hasOwn(response, "error") && ["not_paired", "owner_mismatch", "method_not_allowed", "unsupported_method", "invalid_params", "queue_full", "pairing_expired", "pairing_revoked"].includes(errorCode) || !!data.error || ["not_executed", "unsupported", "unavailable", "denied", "rejected"].includes(string(data.status)) && !["contacts.respond", "approval.respond"].includes(row.method) || data.decision === "deny" && row.method !== "approval.respond";
  const confirmed = !Object.hasOwn(response, "error") && !rejected && data.status !== "uncertain" && (row.method === "collaboration.execute" ? Object.keys(data).length > 0
    : row.method === "contacts.add" ? data.decision === "allow" && ["requested", "request_sent", "pending", "already_requested", "already_connected", "confirmed", "already_confirmed"].includes(string(data.status))
    : row.method === "approval.respond" ? data.approval_id === params.approval_id && (params.decision === "approve" ? data.decision === "allow" && data.status === "approved_once" : data.decision === "deny" && data.status === "denied")
    : row.method === "contacts.respond" ? data.request_id === params.request_id && data.status === (params.decision === "accept" ? "accepted" : "rejected")
    : row.method === "inbox.mark_read" ? data.message_id === params.message_id && (data.status === "read" || data.read === true)
    : data.message_id === params.message_id && ["sent", "queued", "accepted"].includes(string(data.status)));
  const phase = rejected ? "failed" : confirmed ? "succeeded" : "uncertain";
  const result = Object.hasOwn(response, "error") ? { error: response.error } : data;
  const value: WorkspaceOperation = { ...operation, phase, result, retryable: false, updatedAt: Date.now(),
    message: phase === "succeeded" ? "Agent 已返回原操作的认证结果，请查看当前对象的状态。"
      : phase === "failed" ? string(data.error, "Agent 未接受此操作，请核对当前状态与授权。")
      : string(data.instruction, "Agent 尚不能确认此操作是否已执行。请核查原对象；不会自动重新投递。") };
  await db.$executeRaw`UPDATE "WorkspaceOperation" SET "phase" = ${phase}, "payload" = ${seal(userId, agentId, "operation", row.id, value)}, "updatedAt" = ${value.updatedAt}
    WHERE "agentId" = ${agentId} AND "requestId" = ${row.id} AND "phase" IN ('sending','uncertain')`;
}

async function conversationState(db: DB, userId: string, agentId: string, id: string): Promise<WorkspaceConversationState> {
  const row = (await db.$queryRaw<ConversationStateRow[]>`SELECT * FROM "WorkspaceConversationState" WHERE "agentId" = ${agentId} AND "conversationId" = ${id}`)[0];
  return row ? { ...emptyConversationState(), ...unseal<WorkspaceConversationState>(userId, agentId, "conversation-state", id, row.payload) } : emptyConversationState();
}
export async function saveWorkspaceConversationState(userId: string, agentId: string, conversationId: string | null, patch: Partial<WorkspaceConversationState>): Promise<WorkspaceConversationState> {
  if (!await owned(userId, agentId)) throw new ControlError("连接不存在。", 404);
  const id = conversationId || "";
  return prisma.$transaction(async tx => {
    if (id && !(await tx.$queryRaw<{ conversationId: string }[]>`SELECT "conversationId" FROM "WorkspaceConversation" WHERE "agentId" = ${agentId} AND "conversationId" = ${id}`).length)
      throw new ControlError("已保存的对话不存在。", 404);
    const prior = await conversationState(tx, userId, agentId, id), now = Date.now();
    if (patch.deleted === true) {
      if (!id) throw new ControlError("新聊天还没有可删除的历史。", 400);
      await requireNoPendingWrites(tx, userId, agentId);
      if ((await tx.$queryRaw<{ itemId: string }[]>`SELECT "itemId" FROM "WorkspaceItem" WHERE "agentId" = ${agentId} AND "kind" = 'turn' AND "conversationId" = ${id} AND "status" IN ('submitted','running') LIMIT 1`).length)
        throw new ControlError("这段聊天仍在处理，请等实际结果确定后再删除。", 409);
    }
    const next: WorkspaceConversationState = { ...prior, ...patch,
      readAt: patch.readAt === undefined ? prior.readAt : Math.max(prior.readAt, Math.min(now, patch.readAt)) };
    await tx.$executeRaw`INSERT INTO "WorkspaceConversationState" ("agentId","conversationId","payload","updatedAt")
      VALUES (${agentId},${id},${seal(userId, agentId, "conversation-state", id, next)},${now}) ON CONFLICT("agentId","conversationId")
      DO UPDATE SET "payload" = excluded."payload", "updatedAt" = excluded."updatedAt"`;
    if (patch.deleted === true) {
      await tx.$executeRaw`UPDATE "WorkspaceState" SET "activeConversationId" = '', "activeSelectedAt" = ${now} WHERE "agentId" = ${agentId} AND "activeConversationId" = ${id}`;
    }
    if (patch.readAt !== undefined && id) {
      const notices = await tx.$queryRaw<NotificationRow[]>`SELECT * FROM "WorkspaceNotification" WHERE "agentId" = ${agentId} AND "kind" IN ('conversation_completed','conversation_failed') AND "readRevision" < "revision"`;
      for (const notice of notices) {
        const item = unseal<NotificationPayload>(userId, agentId, "notification", notice.id, notice.payload).item;
        if (item.target.kind === "conversation" && item.target.id === id && item.updated_at * 1000 <= next.readAt)
          await tx.$executeRaw`UPDATE "WorkspaceNotification" SET "readRevision" = "revision" WHERE "agentId" = ${agentId} AND "id" = ${notice.id}`;
      }
    }
    return next;
  });
}

export async function listWorkspaceConversations(userId: string, agentId: string, options: { q?: string; archived?: "active" | "archived" | "all"; deleted?: "active" | "deleted" | "all"; before?: string; limit?: number } = {}): Promise<WorkspaceConversationPage> {
  if (!await owned(userId, agentId)) throw new ControlError("连接不存在。", 404);
  const limit = Math.min(50, Math.max(1, options.limit || 25)), query = (options.q || "").trim().toLocaleLowerCase();
  const rows = await prisma.$queryRaw<{ conversationId: string; payload: string; updatedAt: number; turnCount: bigint; pending: bigint }[]>`SELECT c.*,
    (SELECT COUNT(*) FROM "WorkspaceItem" i WHERE i."agentId" = c."agentId" AND i."kind" = 'turn' AND i."conversationId" = c."conversationId") AS "turnCount",
    (SELECT COUNT(*) FROM "WorkspaceItem" i WHERE i."agentId" = c."agentId" AND i."kind" = 'turn' AND i."conversationId" = c."conversationId" AND i."status" IN ('submitted','running')) AS "pending"
    FROM "WorkspaceConversation" c WHERE c."agentId" = ${agentId} ORDER BY c."updatedAt" DESC, c."conversationId" DESC`;
  const metadataRows = await prisma.$queryRaw<ConversationStateRow[]>`SELECT * FROM "WorkspaceConversationState" WHERE "agentId" = ${agentId}`;
  const metadata = new Map(metadataRows.map(row => [row.conversationId, unseal<WorkspaceConversationState>(userId, agentId, "conversation-state", row.conversationId, row.payload)]));
  const cursor = options.before ? rows.find(row => row.conversationId === options.before) : undefined;
  if (options.before && !cursor) throw new ControlError("对话分页位置不存在。", 400);
  const items: WorkspaceConversationPage["items"] = [];
  for (const row of rows) {
    if (cursor && !(row.updatedAt < cursor.updatedAt || row.updatedAt === cursor.updatedAt && row.conversationId < cursor.conversationId)) continue;
    const saved = metadata.get(row.conversationId) || emptyConversationState();
    if ((options.deleted || "active") !== "all" && (saved.deleted === true) !== (options.deleted === "deleted")) continue;
    if ((options.archived || (options.deleted === "deleted" ? "all" : "active")) !== "all" && saved.archived !== (options.archived === "archived")) continue;
    const title = saved.title || string(unseal<RemoteRecord>(userId, agentId, "conversation", row.conversationId, row.payload).title, "新对话");
    let match: WorkspaceConversationPage["items"][number]["match"];
    if (query) {
      // Search only authenticated, saved history; drafts and unconfirmed local sends are excluded.
      const turns = await prisma.$queryRaw<ItemRow[]>`SELECT * FROM "WorkspaceItem" WHERE "agentId" = ${agentId} AND "kind" = 'turn' AND "conversationId" = ${row.conversationId} ORDER BY "sortTime" DESC, "itemId" DESC`;
      const searchable = turns.map(turn => ({ turn, data: unseal<RemoteRecord>(userId, agentId, "turn", turn.itemId, turn.payload) })).filter(item => item.data.locally_unconfirmed !== true);
      if (turns.length && !searchable.length) continue;
      if (!title.toLocaleLowerCase().includes(query)) {
        for (const { turn, data } of searchable) {
          for (const field of ["text", "response"] as const) {
            const text = string(data[field]), at = text.toLocaleLowerCase().indexOf(query);
            if (at >= 0) { match = { turnId: turn.itemId, field, excerpt: text.slice(Math.max(0, at - 40), at + query.length + 100) }; break; }
          }
          if (match) break;
        }
        if (!match) continue;
      }
    }
    items.push({ id: row.conversationId, title, updatedAt: row.updatedAt, pending: Number(row.pending) > 0, turnCount: Number(row.turnCount),
      deleted: saved.deleted === true, archived: saved.archived, readAt: saved.readAt, unread: row.updatedAt > saved.readAt, ...(match ? { match } : {}) });
    if (items.length > limit) break;
  }
  return { items: items.slice(0, limit), before: items.length > limit ? items[limit - 1].id : null, hasMore: items.length > limit, scope: "saved_account_history" };
}

async function deriveConversationNotifications(db: DB, userId: string, agentId: string, conversationId: string, turns: RemoteRecord[], sourceAt: number) {
  const initialized = await notificationBaseline(db, agentId, `conversation:${conversationId}`);
  const saved = await conversationState(db, userId, agentId, conversationId);
  for (const turn of turns) {
    const id = string(turn.turn_id), status = string(turn.status);
    if (!id || !["completed", "failed", "interrupted"].includes(status) || turn.locally_unconfirmed === true) continue;
    const previous = (await db.$queryRaw<ItemRow[]>`SELECT * FROM "WorkspaceItem" WHERE "agentId" = ${agentId} AND "kind" = 'turn' AND "itemId" = ${id} AND "conversationId" = ${conversationId}`)[0];
    const pendingTransition = previous && ["submitted", "running"].includes(previous.status);
    const at = timestamp(turn.updated_at ?? turn.completed_at ?? (pendingTransition ? undefined : turn.created_at), sourceAt);
    const item: AttentionItem = { attention_id: `conversation:${conversationId}:${id}`, subject_id: id,
      kind: status === "completed" ? "conversation_completed" : "conversation_failed", source_revision: status, revision: 1, state: "open",
      title: status === "completed" ? "Agent 已回复" : status === "interrupted" ? "一段对话结果需要核实" : "一段对话处理失败",
      safe_summary: status === "completed" ? "请打开原对话查看回复。回合结束不代表其中的业务目标已完成。"
        : status === "interrupted" ? "本回合已中断，执行结果尚不确定。请打开原对话核实；原请求已保留，不会自动重新发送。"
        : "请打开原对话查看失败原因，不要直接重复发送。",
      target: { kind: "conversation", id: conversationId, turn_id: id }, created_at: timestamp(turn.created_at, sourceAt) / 1000, updated_at: at / 1000 };
    await saveNotification(db, userId, agentId, item, sourceAt, "snapshot", !!pendingTransition || initialized && !previous);
    if (saved.readAt >= at) await db.$executeRaw`UPDATE "WorkspaceNotification" SET "readRevision" = "revision"
      WHERE "agentId" = ${agentId} AND "id" = ${notificationDigest(["conversation", conversationId, id])}`;
  }
  await finishNotificationBaseline(db, agentId, `conversation:${conversationId}`);
}


async function reconcileWorkspaceOperations(db: DB, userId: string, agentId: string, method: string, data: RemoteRecord) {
  if (!["contacts.list", "contacts.requests", "collaboration.state", "inbox.list"].includes(method)) return;
  const rows = await db.$queryRaw<OperationRow[]>`SELECT * FROM "WorkspaceOperation" WHERE "agentId" = ${agentId} AND "phase" IN ('sending','uncertain') AND "method" <> 'collaboration.execute'`;
  for (const row of rows) {
    const operation = decodeOperation(userId, agentId, row), params = operation.call.params;
    let evidence: RemoteRecord | undefined;
    let opposite = false;
    if (row.method === "contacts.add" && !operation.reusedContact && Array.isArray(data.contacts))
      evidence = records(data.contacts).find(item => item.contact_id === params.contact_id && item.urn === params.urn &&
        Array.isArray(params.aliases) && params.aliases.every(alias => Array.isArray(item.aliases) && item.aliases.includes(alias)));
    if (row.method === "approval.respond" && Array.isArray(data.approval_decisions)) {
      evidence = records(data.approval_decisions).find(item => item.approval_id === params.approval_id && ["approved", "denied"].includes(string(item.status)));
      opposite = !!evidence && evidence.status !== (params.decision === "approve" ? "approved" : "denied");
    }
    if (row.method === "contacts.respond" && Array.isArray(data.contact_requests))
      evidence = records(data.contact_requests).find(item => item.request_id === params.request_id && item.status === (params.decision === "accept" ? "accepted" : "rejected"));
    if (row.method === "messages.send" && Array.isArray(data.sent_messages))
      evidence = records(data.sent_messages).find(item => item.message_id === params.message_id && ["sent", "queued", "accepted"].includes(string(item.status)));
    if (row.method === "inbox.mark_read") {
      const inbox = record(data.inbox);
      const messages = Array.isArray(data.messages) ? records(data.messages) : Array.isArray(data.inbox) ? records(data.inbox) : records(inbox.messages);
      evidence = messages.find(item => item.message_id === params.message_id && item.read === true);
    }
    if (!evidence) continue;
    const phase = opposite ? "failed" : "succeeded";
    const value: WorkspaceOperation = { ...operation, phase, retryable: false, result: { source: "authenticated_snapshot", observed: evidence },
      updatedAt: Date.now(), message: opposite ? "Agent 最新决定与原选择不同，请查看当前问题核实。" : "处理结果已从 agent 的认证状态同步。"};
    await db.$executeRaw`UPDATE "WorkspaceOperation" SET "phase" = ${phase}, "payload" = ${seal(userId, agentId, "operation", row.requestId, value)}, "updatedAt" = ${value.updatedAt}
      WHERE "agentId" = ${agentId} AND "requestId" = ${row.requestId} AND "phase" IN ('sending','uncertain')`;
  }
}


async function requireOwnedRecord(db: DB, userId: string, agentId: string) {
  if (!(await db.$queryRaw<{ id: string }[]>`SELECT "id" FROM "Agent" WHERE "id" = ${agentId} AND "userId" = ${userId}`).length)
    throw new ControlError("连接不存在。", 404);
}
async function requireNoPendingWrites(db: DB, userId: string, agentId: string) {
  if ((await db.$queryRaw<{ requestId: string }[]>`SELECT "requestId" FROM "WorkspaceSubmission" WHERE "agentId" = ${agentId} LIMIT 1`).length)
    throw new ControlError("有聊天消息的提交结果尚未确定，请先核实原消息再删除。", 409);
  const operations = await db.$queryRaw<OperationRow[]>`SELECT * FROM "WorkspaceOperation" WHERE "agentId" = ${agentId} AND "phase" IN ('sending','uncertain')`;
  if (operations.some(row => { const call = decodeOperation(userId, agentId, row).call; return !(call.method === "collaboration.execute" && call.params.action === "describe"); }))
    throw new ControlError("有操作的提交结果尚未确定，请保留原记录并核实后再删除。", 409);
  const interrupted = await db.$queryRaw<ItemRow[]>`SELECT * FROM "WorkspaceItem" WHERE "agentId" = ${agentId} AND "kind" = 'turn' AND "status" = 'interrupted'`;
  if (interrupted.some(row => unseal<RemoteRecord>(userId, agentId, "turn", row.itemId, row.payload).locally_unconfirmed === true))
    throw new ControlError("仍有未收到 agent 确认的聊天消息，请先核实原消息再删除。", 409);
}
export async function renameWorkspaceAgent(userId: string, agentId: string, name: string) {
  return prisma.$transaction(async tx => {
    await requireOwnedRecord(tx, userId, agentId);
    await tx.$executeRaw`UPDATE "Agent" SET "name" = ${name}, "updatedAt" = ${new Date()} WHERE "id" = ${agentId} AND "userId" = ${userId}`;
    return { id: agentId, name };
  });
}
export async function removeWorkspaceAgent(userId: string, agentId: string) {
  await prisma.$transaction(async tx => {
    await requireOwnedRecord(tx, userId, agentId);
    await requireNoPendingWrites(tx, userId, agentId);
    if ((await tx.$queryRaw<{ itemId: string }[]>`SELECT "itemId" FROM "WorkspaceItem" WHERE "agentId" = ${agentId} AND "kind" = 'turn' AND "status" IN ('submitted','running') LIMIT 1`).length)
      throw new ControlError("Agent 仍在处理聊天消息，请等结果确定后再移除连接。", 409);
    // Queue entries do not have an Agent foreign key; remove only this connection's deliveries.
    await tx.$executeRaw`DELETE FROM "WebPushDelivery" WHERE "agentId" = ${agentId}`;
    await tx.$executeRaw`DELETE FROM "Agent" WHERE "id" = ${agentId} AND "userId" = ${userId}`;
  });
}
type RecordStateRow = { kind: WorkspaceRecordKind; recordId: string; payload: string; updatedAt: number };
async function recordStates(db: DB, userId: string, agentId: string): Promise<WorkspaceRecordState[]> {
  const rows = await db.$queryRaw<RecordStateRow[]>`SELECT * FROM "WorkspaceRecordState" WHERE "agentId" = ${agentId} ORDER BY "updatedAt" DESC, "kind" ASC, "recordId" ASC`;
  return rows.map(row => unseal<WorkspaceRecordState>(userId, agentId, `record-state:${row.kind}`, row.recordId, row.payload));
}
export async function getWorkspaceRecordStates(userId: string, agentId: string) {
  if (!await owned(userId, agentId)) throw new ControlError("连接不存在。", 404);
  return recordStates(prisma, userId, agentId);
}
function matchesRecord(state: WorkspaceRecordState, kind: WorkspaceRecordKind, id: string) {
  return state.kind === kind && (state.id === id || state.relatedIds?.includes(id));
}
async function savedSnapshot(db: DB, userId: string, agentId: string, method: string): Promise<RemoteRecord> {
  const row = (await db.$queryRaw<SnapshotRow[]>`SELECT * FROM "WorkspaceSnapshot" WHERE "agentId" = ${agentId} AND "method" = ${method} AND "recordKey" = ''`)[0];
  return row ? unseal<RemoteRecord>(userId, agentId, `snapshot:${method}`, "", row.payload) : {};
}
function pendingApproval(approval: RemoteRecord, ids: Set<string>) {
  return ["pending", "presenting", "expired"].includes(string(approval.status)) &&
    [approval.subject_id, approval.task_id, approval.contact_id, record(approval.target).id].some(id => typeof id === "string" && ids.has(id));
}
export async function saveWorkspaceRecordState(userId: string, agentId: string, kind: WorkspaceRecordKind, id: string, deleted: boolean): Promise<WorkspaceRecordState> {
  if (!await owned(userId, agentId)) throw new ControlError("连接不存在。", 404);
  return prisma.$transaction(async tx => {
    await requireOwnedRecord(tx, userId, agentId);
    const states = await recordStates(tx, userId, agentId), previous = states.find(value => matchesRecord(value, kind, id));
    const data = await savedSnapshot(tx, userId, agentId, "collaboration.state");
    const view = Array.isArray(data.collaborations) ? data : record(data.collaboration ?? data.collaboration_v2);
    let task = records(data.tasks).find(value => value.task_id === id || previous?.relatedIds?.includes(string(value.task_id)));
    const collaboration = records(view.collaborations).find(value => value.collaboration_id === id || value.task_id === id || task && value.task_id === task.task_id || previous?.relatedIds?.includes(string(value.collaboration_id)));
    if (!task && collaboration?.task_id) task = records(data.tasks).find(value => value.task_id === collaboration.task_id);
    const contactData = await savedSnapshot(tx, userId, agentId, "contacts.list");
    const contact = records(contactData.contacts ?? data.contacts).find(value => value.contact_id === id);
    if (kind === "contact" ? !contact && !previous : !task && !collaboration && !previous) throw new ControlError("已保存的记录不存在。", 404);
    const recordId = kind === "collaboration" ? string(task?.task_id, string(collaboration?.task_id, previous?.id || id)) : id;
    const relatedIds = kind === "collaboration" ? [...new Set([recordId, string(collaboration?.collaboration_id), ...records(view.collaborations).filter(value => value.task_id === recordId).map(value => string(value.collaboration_id)), ...(previous?.relatedIds || [])].filter(Boolean))] : [id];
    const ids = new Set(relatedIds);
    if (kind === "contact" && contact?.urn) ids.add(string(contact.urn));
    if (kind === "collaboration") for (const operation of records(data.operations))
      if (ids.has(string(operation.task_id)) || ids.has(string(operation.collaboration_id))) ids.add(string(operation.operation_id));
    if (deleted) {
      await requireNoPendingWrites(tx, userId, agentId);
      if (records(data.pending_confirmations ?? data.approvals).some(value => pendingApproval(value, ids)))
        throw new ControlError("这条记录仍有需要你决定的问题，请处理后再删除。", 409);
      if (kind === "contact") {
        const requests = await savedSnapshot(tx, userId, agentId, "contacts.requests");
        const pending = records(requests.contact_requests ?? requests.requests ?? data.contact_requests).some(value => ["pending", "requested", "sending"].includes(string(value.status)) &&
          (value.contact_id === id || !!contact?.urn && (value.sender_urn === contact.urn || value.recipient_urn === contact.urn || value.peer_urn === contact.urn || value.urn === contact.urn)));
        if (["pending", "requested"].includes(string(contact?.connection_status)) || pending)
          throw new ControlError("这位联系人还有未完成的好友申请，请等待结果或先处理申请。", 409);
      } else {
        const linked = records(view.collaborations).filter(value => value.task_id === recordId || ids.has(string(value.collaboration_id)));
        const closed = linked.length > 0 && linked.every(value => value.phase === "closed" && value.withdraw_pending !== true && ["cancelled", "withdrawn", "expired", "agreement_only_complete"].includes(string(value.closure_reason)) &&
          (value.closure_reason !== "agreement_only_complete" || value.agreement_synced === true));
        if (linked.length ? !closed : !["revoked", "expired", "completed", "cancelled", "denied", "rejected"].includes(string(task?.status)))
          throw new ControlError("合作尚未确认结束。请先暂停或处理当前决定，确认终态后再删除网页记录。", 409);
      }
    }
    const title = kind === "contact" ? strings(contact?.aliases)[0] || string(contact?.name, string(contact?.alias, previous?.title || "联系人")) :
      string(record(task?.scope).topic ?? record(task?.scope).goal ?? record(collaboration?.terms).topic, previous?.title || "合作记录");
    const next: WorkspaceRecordState = { kind, id: recordId, deleted, updatedAt: Date.now(), title, relatedIds };
    if (previous && previous.id !== recordId) await tx.$executeRaw`DELETE FROM "WorkspaceRecordState" WHERE "agentId" = ${agentId} AND "kind" = ${kind} AND "recordId" = ${previous.id}`;
    await tx.$executeRaw`INSERT INTO "WorkspaceRecordState" ("agentId","kind","recordId","payload","updatedAt") VALUES (${agentId},${kind},${recordId},${seal(userId, agentId, `record-state:${kind}`, recordId, next)},${next.updatedAt})
      ON CONFLICT("agentId","kind","recordId") DO UPDATE SET "payload" = excluded."payload", "updatedAt" = excluded."updatedAt"`;
    return next;
  });
}


async function requireVisibleOperationTarget(db: DB, userId: string, agentId: string, call: PendingCall) {
  const hidden = (await recordStates(db, userId, agentId)).filter(value => value.deleted);
  if (!hidden.length) return;
  const scope = record(call.params.scope), policy = record(call.params.policy);
  const ids = new Set([string(call.params.contact_id), string(call.params.task_id), string(call.params.collaboration_id), string(call.params.peer_id),
    string(call.params.recipient_id), string(policy.collaboration_id), ...strings(call.params.recipient_ids), ...strings(scope.recipient_ids)]);
  if (call.params.recipient_urn) {
    const contacts = await savedSnapshot(db, userId, agentId, "contacts.list");
    for (const contact of records(contacts.contacts)) if (contact.urn === call.params.recipient_urn) ids.add(string(contact.contact_id));
  }
  if (hidden.some(value => [value.id, ...(value.relatedIds || [])].some(id => ids.has(id))))
    throw new ControlError("操作对象已从网页列表删除，请先恢复记录再发起新操作。", 409);
}
