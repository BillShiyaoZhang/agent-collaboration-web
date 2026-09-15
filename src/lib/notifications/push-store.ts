import crypto from "crypto";
import webpush from "web-push";
import { prisma } from "@/lib/shared/db";
import { ControlError } from "@/lib/control/control-transport";
import { allowedPushEndpoint, isGonePushStatus, PUSH_FRESH_MS, PUSH_LEASE_MS, PUSH_TTL_MS, pushRetryDelay, pushSubject, type BrowserPushSubscription } from "./push-policy";

type Subscription = { id: string; userId: string; deviceId: string; binding: string; endpointHash: string; payload: string; active: number; enabledAt: number; expiresAt: number; visibleUntil: number; lastTestAt: number; lastError: string | null };
type Delivery = { id: string; subscriptionId: string; agentId: string; notificationId: string; revision: number; kind: string; status: string; attempts: number; claimed: number; nextAttemptAt: number; expiresAt: number; leaseToken: string | null; leaseUntil: number | null; updatedAt: number; lastError: string | null };
type Vapid = { publicKey: string; privateKey: string };
const ACTIONABLE = "'owner_decision_required','needs_recovery','connection_action_required','needs_response','new_collaboration_request'";
const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
function storageKey() {
  if (!process.env.NEXTAUTH_SECRET) throw new ControlError("服务器尚未配置推送加密。", 503);
  return crypto.createHmac("sha256", process.env.NEXTAUTH_SECRET).update("agent-web-push/storage/v1").digest();
}
function seal(identity: string[], value: unknown): string {
  const nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", storageKey(), nonce);
  cipher.setAAD(Buffer.from(JSON.stringify(identity)));
  return ["v1", nonce.toString("base64url"), Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]).toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}
function unseal<T>(identity: string[], value: string): T {
  const [version, nonce, data, tag, extra] = value.split(".");
  if (version !== "v1" || !nonce || !data || !tag || extra) throw new Error("Invalid push ciphertext");
  const cipher = crypto.createDecipheriv("aes-256-gcm", storageKey(), Buffer.from(nonce, "base64url"));
  cipher.setAAD(Buffer.from(JSON.stringify(identity))); cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(data, "base64url")), cipher.final()]).toString());
}
async function keys(): Promise<Vapid> {
  let rows = await prisma.$queryRaw<{ payload: string }[]>`SELECT "payload" FROM "WebPushConfig" WHERE "id" = 'vapid-v1'`;
  if (!rows.length) {
    await prisma.$executeRaw`INSERT OR IGNORE INTO "WebPushConfig" ("id","payload","createdAt") VALUES ('vapid-v1',${seal(["vapid-v1"], webpush.generateVAPIDKeys())},${Date.now()})`;
    rows = await prisma.$queryRaw<{ payload: string }[]>`SELECT "payload" FROM "WebPushConfig" WHERE "id" = 'vapid-v1'`;
  }
  return unseal<Vapid>(["vapid-v1"], rows[0].payload);
}
async function subscription(userId: string, deviceId: string): Promise<Subscription | undefined> {
  return (await prisma.$queryRaw<Subscription[]>`SELECT * FROM "WebPushSubscription" WHERE "userId" = ${userId} AND "deviceId" = ${deviceId}`)[0];
}
export async function getPushSettings(userId: string, deviceId: string) {
  const subject = pushSubject(), sub = await subscription(userId, deviceId);
  const recent = sub ? await prisma.$queryRaw<Pick<Delivery, "kind" | "status" | "updatedAt" | "lastError">[]>`SELECT "kind","status","updatedAt","lastError" FROM "WebPushDelivery" WHERE "subscriptionId" = ${sub.id} ORDER BY "updatedAt" DESC LIMIT 1` : [];
  return { accountId: userId, available: !!subject, publicKey: subject ? (await keys()).publicKey : null,
    subscription: sub && sub.active && sub.expiresAt > Date.now() ? { id: sub.id, binding: sub.binding, accountId: userId, expiresAt: sub.expiresAt } : null,
    lastDelivery: recent[0] ?? null, lastError: sub?.lastError ?? null };
}
export async function savePushSubscription(userId: string, deviceId: string, value: BrowserPushSubscription) {
  if (!pushSubject()) throw new ControlError("服务器尚未启用关闭页面后的推送。", 503);
  if (!allowedPushEndpoint(value.endpoint)) throw new ControlError("此浏览器的推送服务暂不受支持。", 400);
  const now = Date.now(), expiresAt = Math.min(now + PUSH_LEASE_MS, value.expirationTime ?? Infinity);
  if (expiresAt <= now) throw new ControlError("浏览器订阅已过期，请重新开启。", 409);
  const endpointHash = hash(value.endpoint);
  await prisma.$transaction(async tx => {
    const previous = (await tx.$queryRaw<Subscription[]>`SELECT * FROM "WebPushSubscription" WHERE "userId" = ${userId} AND "deviceId" = ${deviceId}`)[0];
    const occupied = (await tx.$queryRaw<Subscription[]>`SELECT * FROM "WebPushSubscription" WHERE "endpointHash" = ${endpointHash}`)[0];
    if (occupied && (occupied.userId !== userId || occupied.deviceId !== deviceId)) throw new ControlError("浏览器订阅属于另一登录范围，请重新开启订阅。", 409);
    const count = (await tx.$queryRaw<{ total: bigint }[]>`SELECT COUNT(*) AS "total" FROM "WebPushSubscription" WHERE "userId"=${userId} AND "active"=1 AND "expiresAt">${now} AND "deviceId"<>${deviceId}`)[0];
    if (Number(count.total) >= 8) throw new ControlError("此账号已在 8 个设备开启推送，请先关闭不用的设备。", 409);
    if (previous && previous.active && previous.endpointHash === endpointHash) {
      await tx.$executeRaw`UPDATE "WebPushSubscription" SET "payload" = ${seal([userId, previous.id], value)}, "expiresAt" = ${expiresAt}, "lastError" = NULL WHERE "id" = ${previous.id}`;
      return;
    }
    if (previous) await tx.$executeRaw`DELETE FROM "WebPushSubscription" WHERE "id" = ${previous.id}`;
    const id = crypto.randomUUID(), binding = crypto.randomBytes(24).toString("base64url");
    await tx.$executeRaw`INSERT INTO "WebPushSubscription" ("id","userId","deviceId","endpointHash","binding","payload","enabledAt","expiresAt")
      VALUES (${id},${userId},${deviceId},${endpointHash},${binding},${seal([userId, id], value)},${now},${expiresAt})`;
  });
  return getPushSettings(userId, deviceId);
}
export async function revokePushSubscription(userId: string, deviceId: string) {
  // Permission reduction immediately fences sending and SW display verification.
  await prisma.$executeRaw`UPDATE "WebPushSubscription" SET "active" = 0, "visibleUntil" = 0 WHERE "userId" = ${userId} AND "deviceId" = ${deviceId}`;
}
export async function updatePushPresence(userId: string, deviceId: string, focused: boolean) {
  const now = Date.now();
  await prisma.$executeRaw`UPDATE "WebPushSubscription" SET "visibleUntil" = ${focused ? now + 25000 : 0} WHERE "userId" = ${userId} AND "deviceId" = ${deviceId} AND "active" = 1`;
}
export async function queuePushTest(userId: string, deviceId: string) {
  const sub = await subscription(userId, deviceId), now = Date.now();
  if (!sub?.active || sub.expiresAt <= now) throw new ControlError("请先开启此设备的后台推送。", 409);
  const id = crypto.randomUUID();
  await prisma.$transaction(async tx => {
    const updated = await tx.$executeRaw`UPDATE "WebPushSubscription" SET "lastTestAt" = ${now} WHERE "id" = ${sub.id} AND "userId" = ${userId} AND "active" = 1 AND "lastTestAt" <= ${now - 60000}`;
    if (!updated) throw new ControlError("测试提醒每分钟可发送一次，请稍后再试。", 429);
    await tx.$executeRaw`INSERT INTO "WebPushDelivery" ("id","subscriptionId","agentId","notificationId","revision","kind","nextAttemptAt","expiresAt","updatedAt")
      VALUES (${id},${sub.id},'',${id},1,'test',${now},${now + 120000},${now})`;
  });
  return { queued: true, deliveryId: id };
}
async function eligible(delivery: Delivery, sub: Subscription): Promise<boolean> {
  if (!sub.active || sub.expiresAt <= Date.now() || delivery.expiresAt <= Date.now()) return false;
  if (delivery.kind === "test") return true;
  const now = Date.now();
  const rows = await prisma.$queryRaw<{ id: string }[]>`SELECT n."id" FROM "WorkspaceNotification" n JOIN "Agent" a ON a."id" = n."agentId"
    WHERE a."userId" = ${sub.userId} AND n."agentId" = ${delivery.agentId} AND n."id" = ${delivery.notificationId} AND n."revision" = ${delivery.revision}
    AND n."state" = 'open' AND n."readRevision" < n."revision" AND n."systemEligible" = 1 AND (n."expiresAt" IS NULL OR n."expiresAt" > ${now}) AND n."sourceAt" > ${now - PUSH_FRESH_MS}`;
  return !!rows.length;
}
export async function resolvePushDisplay(userId: string, deliveryId: string, binding: string) {
  const row = (await prisma.$queryRaw<Delivery[]>`SELECT d.* FROM "WebPushDelivery" d JOIN "WebPushSubscription" s ON s."id" = d."subscriptionId"
    WHERE d."id" = ${deliveryId} AND s."userId" = ${userId} AND s."binding" = ${binding}`)[0];
  if (!row) throw new ControlError("推送已失效。", 404);
  const sub = (await prisma.$queryRaw<Subscription[]>`SELECT * FROM "WebPushSubscription" WHERE "id" = ${row.subscriptionId}`)[0];
  if (!sub || !await eligible(row, sub) || !["sending", "sent", "received", "deferred", "displayed"].includes(row.status)) return { valid: false };
  await prisma.$executeRaw`UPDATE "WebPushDelivery" SET "status" = 'received', "updatedAt" = ${Date.now()} WHERE "id" = ${row.id} AND "status" IN ('sending','sent','received','deferred')`;
  return { valid: true, accountId: userId, binding, deliveryId: row.id, expiresAt: row.expiresAt,
    title: row.kind === "test" ? "Agent Comm 测试提醒" : "Agent Comm 协作提醒",
    body: row.kind === "test" ? "后台推送已到达此浏览器。点击可返回提醒中心查看诊断。" : "有新的协作进展。打开提醒中心核对当前状态，需要决定时在原生对话中处理。",
    tag: `agent-comm-push:${sub.id}:${row.kind === "test" ? "test" : row.notificationId}`, test: row.kind === "test" };
}
export async function recordPushReceipt(userId: string, deliveryId: string, binding: string, status: "displayed" | "suppressed" | "display_error" | "deferred") {
  const now = Date.now();
  await prisma.$executeRaw`UPDATE "WebPushDelivery" SET "status" = ${status}, "updatedAt" = ${now}, "nextAttemptAt" = ${now + 30000} WHERE "id" = ${deliveryId}
    AND "status" IN ('sending','sent','received','deferred') AND "subscriptionId" IN (SELECT "id" FROM "WebPushSubscription" WHERE "userId" = ${userId} AND "binding" = ${binding} AND "active" = 1)`;
}

// A DB queue and expiring leases recover after process crashes. Push services may
// redeliver; the SW deduplicates delivery IDs before requesting a visible notice.
export async function runPushTick(send = webpush.sendNotification.bind(webpush)) {
  const subject = pushSubject(); if (!subject) return;
  const now = Date.now();
  await prisma.$executeRaw`UPDATE "WebPushSubscription" SET "active" = 0 WHERE "active" = 1 AND "expiresAt" <= ${now}`;
  await prisma.$executeRaw`UPDATE "WebPushDelivery" SET "status" = 'expired', "leaseToken" = NULL, "leaseUntil" = NULL, "updatedAt" = ${now}
    WHERE "status" IN ('pending','sending','sent','received','deferred') AND "expiresAt" <= ${now}`;
  await prisma.$executeRaw`DELETE FROM "WebPushDelivery" WHERE "updatedAt" < ${now - 7 * 86400000} AND "status" NOT IN ('pending','sending')`;
  // Parameterized constants only; the interpolated actionable list is fixed code.
  await prisma.$executeRawUnsafe(`INSERT OR IGNORE INTO "WebPushDelivery" ("id","subscriptionId","agentId","notificationId","revision","nextAttemptAt","expiresAt","updatedAt")
    SELECT lower(hex(randomblob(16))),s."id",n."agentId",n."id",n."revision",?,MIN(COALESCE(n."expiresAt",?),?),?
    FROM "WebPushSubscription" s JOIN "Agent" a ON a."userId"=s."userId" JOIN "WorkspaceNotification" n ON n."agentId"=a."id"
    WHERE s."active"=1 AND s."expiresAt">? AND n."state"='open' AND n."readRevision"<n."revision" AND n."systemEligible"=1
    AND (n."expiresAt" IS NULL OR n."expiresAt">?) AND n."sourceAt">?
    AND (n."updatedAt">s."enabledAt" OR n."kind" IN (${ACTIONABLE}))
    AND NOT EXISTS (SELECT 1 FROM "WorkspaceNotificationDelivery" c WHERE c."agentId"=n."agentId" AND c."notificationId"=n."id" AND c."revision"=n."revision" AND c."deviceId"=s."deviceId")
    AND NOT EXISTS (SELECT 1 FROM "WebPushDelivery" d WHERE d."subscriptionId"=s."id" AND d."agentId"=n."agentId" AND d."notificationId"=n."id" AND d."revision"=n."revision")
    ORDER BY n."seq" DESC LIMIT 100`, now, now + PUSH_TTL_MS, now + PUSH_TTL_MS, now, now, now, now - PUSH_FRESH_MS);
  const due = await prisma.$queryRaw<Delivery[]>`SELECT d.* FROM "WebPushDelivery" d JOIN "WebPushSubscription" s ON s."id"=d."subscriptionId"
    WHERE s."active"=1 AND s."expiresAt">${now} AND (d."kind"='test' OR s."visibleUntil"<=${now}) AND d."expiresAt">${now}
    AND d."attempts"<5 AND d."nextAttemptAt"<=${now} AND (d."status"='pending' OR d."status"='sending' AND d."leaseUntil"<${now}
      OR d."status" IN ('sent','received','deferred') AND d."updatedAt"<${now - 30000}) ORDER BY d."nextAttemptAt" LIMIT 4`;
  for (const row of due) {
    const token = crypto.randomUUID(), claimTime = Date.now();
    const leased = await prisma.$executeRaw`UPDATE "WebPushDelivery" SET "status"='sending',"leaseToken"=${token},"leaseUntil"=${claimTime + 30000},"attempts"="attempts"+1,"updatedAt"=${claimTime}
      WHERE "id"=${row.id} AND ("status"='pending' OR "status"='sending' AND "leaseUntil"<${claimTime} OR "status" IN ('sent','received','deferred') AND "updatedAt"<${claimTime - 30000})`;
    if (!leased) continue;
    const sub = (await prisma.$queryRaw<Subscription[]>`SELECT * FROM "WebPushSubscription" WHERE "id"=${row.subscriptionId}`)[0];
    if (!sub || !await eligible(row, sub)) { await finish(row.id, token, "expired"); continue; }
    if (row.kind !== "test" && !row.claimed) {
      const claimed = await prisma.$transaction(async tx => {
        const inserted = await tx.$executeRaw`INSERT OR IGNORE INTO "WorkspaceNotificationDelivery" ("agentId","notificationId","revision","deviceId","claimedAt")
          SELECT n."agentId",n."id",n."revision",${sub.deviceId},${Date.now()} FROM "WorkspaceNotification" n WHERE n."agentId"=${row.agentId} AND n."id"=${row.notificationId}
          AND n."revision"=${row.revision} AND n."state"='open' AND n."readRevision"<n."revision" AND (n."expiresAt" IS NULL OR n."expiresAt">${Date.now()})`;
        if (inserted) await tx.$executeRaw`UPDATE "WebPushDelivery" SET "claimed"=1 WHERE "id"=${row.id} AND "leaseToken"=${token}`;
        return !!inserted;
      });
      if (!claimed) { await finish(row.id, token, "suppressed"); continue; }
    }
    try {
      const value = unseal<BrowserPushSubscription>([sub.userId, sub.id], sub.payload);
      if (!allowedPushEndpoint(value.endpoint)) throw new Error("invalid_endpoint");
      const vapid = await keys();
      await send(value, JSON.stringify({ schema: "agent-comm-push/v1", deliveryId: row.id, binding: sub.binding, expiresAt: row.expiresAt }),
        { vapidDetails: { subject, ...vapid }, TTL: Math.max(0, Math.floor((row.expiresAt - Date.now()) / 1000)), urgency: "normal", topic: hash(row.id).slice(0, 32), timeout: 10000 });
      // A fast SW receipt may already have advanced status; never overwrite it.
      await finish(row.id, token, "sent");
      await prisma.$executeRaw`UPDATE "WebPushSubscription" SET "lastError"=NULL WHERE "id"=${sub.id}`;
    } catch (error) {
      const status = typeof error === "object" && error !== null && "statusCode" in error ? Number(error.statusCode) : undefined;
      const code = isGonePushStatus(status) ? "subscription_expired" : status === 401 || status === 403 ? "push_authorization_failed" : "push_service_unavailable";
      const terminal = isGonePushStatus(status) || status === 401 || status === 403 || row.attempts + 1 >= 5;
      if (isGonePushStatus(status)) await prisma.$executeRaw`UPDATE "WebPushSubscription" SET "active"=0,"lastError"=${code} WHERE "id"=${sub.id}`;
      else await prisma.$executeRaw`UPDATE "WebPushSubscription" SET "lastError"=${code} WHERE "id"=${sub.id}`;
      await prisma.$executeRaw`UPDATE "WebPushDelivery" SET "status"=${terminal ? "failed" : "pending"},"lastError"=${code},"nextAttemptAt"=${Date.now() + pushRetryDelay(row.attempts + 1)},"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=${Date.now()}
        WHERE "id"=${row.id} AND "leaseToken"=${token} AND "status"='sending'`;
    }
  }
}
async function finish(id: string, token: string, status: string) {
  await prisma.$executeRaw`UPDATE "WebPushDelivery" SET "status"=${status},"leaseToken"=NULL,"leaseUntil"=NULL,"updatedAt"=${Date.now()} WHERE "id"=${id} AND "leaseToken"=${token} AND "status"='sending'`;
}
