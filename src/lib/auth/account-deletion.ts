import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/shared/db";
import { AccountEmailError, normalizedEmail } from "./account-email";
import { validPasswordSize, verifyPassword } from "./password";

// Explicit cleanup also covers upgraded databases whose original tables lacked
// foreign keys. Identifiers are fixed by source; account values are parameterized.
const AGENT_TABLES = ["WorkspacePeerSafety", "WorkspaceNotificationDelivery", "WorkspaceNotification", "WorkspaceNotificationBaseline", "WorkspaceRecordState", "WorkspaceConversationState", "WorkspaceOperation", "WorkspaceSubmission", "WorkspaceConversation", "WorkspaceItem", "WorkspaceSnapshot", "WorkspaceState", "ControlRequest"];
const ACCOUNT_TABLES = ["ManagedConsoleCertificate", "UserPolicyConsent", "UserControlPause", "EmailActionToken", "ModerationReport", "ModerationContent", "ModerationRate"];
const LEGACY_TABLES = ["Contact", "Message", "HITLRequest", "Transaction"];
const KNOWN_TABLES = new Set(["User", "Agent", "OnboardingTicket", "WebPushSubscription", "WebPushDelivery", "AuthEmailSend", ...AGENT_TABLES, ...ACCOUNT_TABLES, ...LEGACY_TABLES]);
const identifier = (name: string) => Prisma.raw('"' + name.replaceAll('"', '""') + '"');
type Dependencies = { db?: PrismaClient; verify?: typeof verifyPassword };

function unsafeSchema() {
  return new AccountEmailError("当前服务的账户存档尚未支持安全删除，请联系工作区运营者升级后再操作。", 503, "DELETE_SCHEMA_UNSUPPORTED");
}

async function inspectArchives(tx: Prisma.TransactionClient) {
  const rows = await tx.$queryRaw<Array<{ name: string }>>`SELECT "name" FROM "sqlite_master" WHERE "type" = 'table' AND "name" NOT LIKE 'sqlite_%'`;
  const present = new Set(rows.map(row => row.name));
  for (const name of rows.map(row => row.name)) {
    if (KNOWN_TABLES.has(name) && !LEGACY_TABLES.includes(name)) continue;
    const columns = await tx.$queryRaw<Array<{ name: string }>>(Prisma.sql`PRAGMA table_info(${identifier(name)})`);
    const names = new Set(columns.map(column => column.name));
    if (LEGACY_TABLES.includes(name)) {
      if (!names.has("userId") || !names.has("agentId")) throw unsafeSchema();
    } else if (names.has("userId") || names.has("agentId")) {
      // Never silently leave behind an unrecognized account-owned archive.
      throw unsafeSchema();
    } else {
      const relations = await tx.$queryRaw<Array<{ table: string }>>(Prisma.sql`PRAGMA foreign_key_list(${identifier(name)})`);
      if (relations.some(relation => KNOWN_TABLES.has(relation.table))) throw unsafeSchema();
    }
  }
  return present;
}

export function createAccountDeletionService(dependencies: Dependencies = {}) {
  const db = dependencies.db || prisma, verify = dependencies.verify || verifyPassword;
  return {
    async deleteAccount(userId: string, currentPassword: string, sessionVersion: number) {
      if (!userId || !Number.isInteger(sessionVersion) || sessionVersion < 0) throw new AccountEmailError("请重新登录后再删除账户。", 401, "UNAUTHORIZED");
      if (!validPasswordSize(currentPassword)) throw new AccountEmailError("请填写有效的当前密码。", 400, "INVALID_INPUT");
      const account = await db.user.findUnique({ where: { id: userId }, select: { email: true, passwordHash: true, sessionVersion: true, virtualUrn: true } });
      if (!account) throw new AccountEmailError("请重新登录后确认账户状态。", 401, "UNAUTHORIZED");
      if (account.sessionVersion !== sessionVersion) throw new AccountEmailError("账户状态已改变，请重新登录后再操作。", 409, "ACCOUNT_CHANGED");
      if (!await verify(currentPassword, account.passwordHash)) throw new AccountEmailError("当前密码不正确，账户未删除。", 400, "INVALID_PASSWORD");

      // No automatic retry: an unexpected transport/database failure is reported
      // for the caller to verify, never interpreted as proof that deletion failed.
      return db.$transaction(async tx => {
        const locked = await tx.user.updateMany({ where: { id: userId, sessionVersion, passwordHash: account.passwordHash }, data: { sessionVersion: { increment: 1 } } });
        if (locked.count !== 1) throw new AccountEmailError("账户状态已改变，请重新登录后再操作。", 409, "ACCOUNT_CHANGED");
        const present = await inspectArchives(tx);
        const agents = Prisma.sql`SELECT "id" FROM "Agent" WHERE "userId" = ${userId}`;
        for (const table of LEGACY_TABLES) if (present.has(table)) {
          await tx.$executeRaw(Prisma.sql`DELETE FROM ${identifier(table)} WHERE "userId" = ${userId} OR "agentId" IN (${agents})`);
        }
        await tx.$executeRaw`DELETE FROM "WebPushDelivery" WHERE "subscriptionId" IN (SELECT "id" FROM "WebPushSubscription" WHERE "userId" = ${userId})`;
        await tx.$executeRaw`DELETE FROM "WebPushSubscription" WHERE "userId" = ${userId}`;
        await tx.$executeRaw(Prisma.sql`DELETE FROM "OnboardingTicket" WHERE "userId" = ${userId} OR "agentId" IN (${agents})`);
        for (const table of AGENT_TABLES) if(present.has(table)) await tx.$executeRaw(Prisma.sql`DELETE FROM ${identifier(table)} WHERE "agentId" IN (${agents})`);
        for (const table of ACCOUNT_TABLES) if (present.has(table)) await tx.$executeRaw(Prisma.sql`DELETE FROM ${identifier(table)} WHERE "userId" = ${userId}`);

        // Legacy installations can contain two case-variant accounts. Hash-only
        // email logs have no ownership key; retain shared rows for the other account.
        const email = normalizedEmail(account.email);
        const otherRecipients = await tx.$queryRaw<Array<{ id: string }>>`SELECT "id" FROM "User" WHERE "id" <> ${userId} AND lower(trim("email")) = ${email} LIMIT 1`;
        if (otherRecipients.length === 0) {
          const recipientHash = createHash("sha256").update(email).digest("hex");
          await tx.authEmailSend.deleteMany({ where: { recipientHash } });
        }
        await tx.agent.deleteMany({ where: { userId } });
        const deleted = await tx.user.deleteMany({ where: { id: userId, sessionVersion: sessionVersion + 1, passwordHash: account.passwordHash } });
        if (deleted.count !== 1) throw new AccountEmailError("账户状态已改变，请重新登录后再操作。", 409, "ACCOUNT_CHANGED");
        return { deleted: true, consoleUrn: account.virtualUrn, message: "账户及本工作区保存的账户数据已删除。其他设备的登录会话已失效。" };
      }, { maxWait: 10000, timeout: 10000 });
    },
  };
}

export const accountDeletionService = createAccountDeletionService();
