import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PrismaClient, Prisma } from "@prisma/client";
import { prisma } from "@/lib/shared/db";
import { hashPassword, verifyPassword } from "./password";

type Purpose = "verify-email" | "reset-password" | "change-password";
type Account = { id: string; email: string; passwordHash: string; emailVerifiedAt: Date | null; requiresEmailVerification: boolean; sessionVersion: number };
type Config = { apiKey: string; origin: string; from: string; replyTo: string; dailyLimit: number };
type Dependencies = { db?: PrismaClient; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => number };
const LIFETIME: Record<Purpose, number> = { "verify-email": 24 * 60 * 60 * 1000, "reset-password": 30 * 60 * 1000, "change-password": 30 * 60 * 1000 };
const GENERIC_MESSAGE = "如果该邮箱需要此操作，系统会尝试发送邮件。请检查收件箱和垃圾邮件，未收到时可稍后重试。";
export class AccountEmailError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) { super(message); }
}
function digest(value: string) { return createHash("sha256").update(value).digest("hex"); }
export function normalizedEmail(value: string) { return value.trim().toLowerCase(); }
export function safeEmailCallback(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/dashboard";
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded.startsWith("/") || decoded.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decoded)) return "/dashboard";
    const url = new URL(value, "https://internal.invalid");
    const destination = url.pathname + url.search + url.hash;
    // Dot-segment normalization can turn /..//example into //example.
    if (url.origin !== "https://internal.invalid" || destination.startsWith("//")) return "/dashboard";
    return destination;
  } catch { return "/dashboard"; }
}
export function accountEmailConfig(env: NodeJS.ProcessEnv = process.env): Config {
  let url: URL;
  try { url = new URL(env.NEXTAUTH_URL || ""); } catch { throw new AccountEmailError("邮箱服务尚未配置，请稍后重试。", 503, "EMAIL_NOT_CONFIGURED"); }
  const from = env.AUTH_EMAIL_FROM?.trim() || "";
  const replyTo = env.AUTH_EMAIL_REPLY_TO?.trim() || "";
  const dailyLimit = Number(env.AUTH_EMAIL_DAILY_LIMIT || 90);
  const address = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
  const fromAddress = from.includes("<") ? /^([^<>\r\n]+) <([^<>]+)>$/.exec(from)?.[2] : from;
  if (!env.RESEND_API_KEY?.trim() || !fromAddress || !address.test(fromAddress) || (replyTo && !address.test(replyTo)) ||
      /[\r\n]/.test(from + replyTo) || url.username || url.password ||
      !["http:", "https:"].includes(url.protocol) || (env.NODE_ENV === "production" && url.protocol !== "https:") ||
      !Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 100) {
    throw new AccountEmailError("邮箱服务尚未配置，请稍后重试。", 503, "EMAIL_NOT_CONFIGURED");
  }
  return { apiKey: env.RESEND_API_KEY.trim(), origin: url.origin, from, replyTo, dailyLimit };
}
function escapeHtml(value: string) { return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]!)); }
export function accountEmailContent(purpose: Purpose, url: string) {
  const titles = { "verify-email": "验证你的 Agent Comm 邮箱", "reset-password": "重置你的 Agent Comm 密码", "change-password": "确认修改你的 Agent Comm 密码" };
  const instructions = {
    "verify-email": "请确认这是你本人注册或验证邮箱的操作。确认后即可使用该邮箱登录。",
    "reset-password": "你或其他人请求重置此账号的密码。打开链接后设置新密码。",
    "change-password": "你在账号设置中请求修改密码。只有打开链接并明确确认后，新密码才会生效。",
  };
  const expiry = purpose === "verify-email" ? "24 小时" : "30 分钟";
  const text = `${instructions[purpose]}\n\n${url}\n\n此链接 ${expiry}内有效，只能使用一次。如果不是你本人操作，请忽略邮件，不要确认；账号不会因此被验证或更改密码。此邮件由系统自动发送。`;
  const html = `<!doctype html><html lang="zh-CN"><body style="font-family:Arial,sans-serif;line-height:1.7;color:#172033;max-width:600px;margin:32px auto;padding:0 20px"><h1 style="font-size:22px">${titles[purpose]}</h1><p>${instructions[purpose]}</p><p><a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 20px;background:#1f2937;color:white;text-decoration:none;border-radius:6px">打开确认页面</a></p><p>链接 ${expiry}内有效，只能使用一次。</p><p>如果不是你本人操作，请忽略邮件，不要确认；账号不会因此被验证或更改密码。此邮件由系统自动发送。</p><p style="word-break:break-all">无法点击按钮时，请复制此地址：<br>${escapeHtml(url)}</p></body></html>`;
  return { subject: titles[purpose], html, text };
}
async function retryTransaction<T>(db: PrismaClient, callback: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.$transaction(callback, { maxWait: 10000, timeout: 10000 }); }
    catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : "";
      if (attempt >= 2 || !["P1008", "P2034"].includes(String(code))) throw error;
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
export function createAccountEmailService(dependencies: Dependencies = {}) {
  const db = dependencies.db || prisma, env = dependencies.env || process.env;
  const sendFetch = dependencies.fetch || fetch, now = dependencies.now || Date.now;
  const findAccount = async (email: string): Promise<Account | null> => {
    // Old installations may have preserved mixed-case email addresses.
    const rows = await db.$queryRaw<Account[]>`SELECT "id", "email", "passwordHash", "emailVerifiedAt", "requiresEmailVerification", "sessionVersion" FROM "User" WHERE lower("email") = ${normalizedEmail(email)} LIMIT 1`;
    return rows[0] || null;
  };
  async function reserve(tx: Prisma.TransactionClient, email: string, purpose: Purpose, config: Config, timestamp: number) {
    const recipientHash = digest(normalizedEmail(email));
    const recent = await tx.authEmailSend.findFirst({ where: { recipientHash, createdAt: { gt: timestamp - 60000 } }, orderBy: { createdAt: "desc" } });
    if (recent && (recent.status !== "failed" || recent.createdAt > timestamp - 15000)) throw new AccountEmailError("请求过于频繁，请稍后重试。", 429, "EMAIL_RATE_LIMITED");
    if (await tx.authEmailSend.count({ where: { createdAt: { gt: timestamp - 60000 } } }) >= 10) throw new AccountEmailError("邮件发送繁忙，请稍后重试。", 429, "EMAIL_RATE_LIMITED");
    const day = new Date(timestamp).toISOString().slice(0, 10);
    await tx.authEmailBudget.upsert({ where: { day }, create: { day, used: 0 }, update: {} });
    const budget = await tx.authEmailBudget.updateMany({ where: { day, used: { lt: config.dailyLimit } }, data: { used: { increment: 1 } } });
    if (budget.count !== 1) throw new AccountEmailError("今日邮件额度已用完，请稍后重试。", 429, "EMAIL_RATE_LIMITED");
    // Bound metadata retention; old action tokens cannot authorize any action.
    await tx.emailActionToken.deleteMany({ where: { expiresAt: { lt: timestamp - 86400000 } } });
    await tx.authEmailSend.deleteMany({ where: { createdAt: { lt: timestamp - 7 * 86400000 } } });
    await tx.authEmailBudget.deleteMany({ where: { day: { lt: new Date(timestamp - 7 * 86400000).toISOString().slice(0, 10) } } });
    return tx.authEmailSend.create({ data: { id: randomUUID(), recipientHash, purpose, createdAt: timestamp, status: "reserved" } });
  }
  async function sendAction(account: Account, purpose: Purpose, passwordHash?: string, callbackUrl?: string) {
    const config = accountEmailConfig(env), timestamp = now(), token = randomBytes(32).toString("base64url"), hash = digest(token);
    const reservation = await retryTransaction(db, async tx => {
      const send = await reserve(tx, account.email, purpose, config, timestamp);
      await tx.emailActionToken.create({ data: { hash, userId: account.id, purpose, sessionVersion: account.sessionVersion, passwordHash, callbackUrl, createdAt: timestamp, expiresAt: timestamp + LIFETIME[purpose] } });
      return send;
    });
    const page = purpose === "change-password" ? "confirm-password-change" : purpose;
    const url = new URL("/" + page, config.origin);
    url.searchParams.set("token", token);
    if (callbackUrl && purpose === "verify-email") url.searchParams.set("callbackUrl", safeEmailCallback(callbackUrl));
    try {
      const response = await sendFetch("https://api.resend.com/emails", {
        method: "POST", headers: { Authorization: "Bearer " + config.apiKey, "Content-Type": "application/json", "Idempotency-Key": "account-email/" + reservation.id },
        body: JSON.stringify({ from: config.from, to: [account.email], ...(config.replyTo ? { reply_to: config.replyTo } : {}), ...accountEmailContent(purpose, url.toString()) }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error("Provider rejected mail");
      const result: unknown = await response.json();
      if (!result || typeof result !== "object" || !("id" in result) || typeof result.id !== "string" || !result.id) throw new Error("No provider acceptance receipt");
    } catch {
      await db.authEmailSend.update({ where: { id: reservation.id }, data: { status: "failed" } });
      // Never activate a token for a failed/uncertain submission or log a raw token.
      throw new AccountEmailError("邮件暂时无法发送，请稍后重试。", 503, "EMAIL_SEND_FAILED");
    }
    await retryTransaction(db, async tx => {
      const current = await tx.user.findUnique({ where: { id: account.id }, select: { sessionVersion: true } });
      // A reset can consume an in-flight token while the provider is responding.
      // Never revive it or let an earlier account generation revoke fresh links.
      if (current?.sessionVersion === account.sessionVersion) {
        const activated = await tx.emailActionToken.updateMany({ where: { hash, consumedAt: null, expiresAt: { gt: now() } }, data: { activeAt: now() } });
        if (activated.count === 1) {
          await tx.emailActionToken.updateMany({ where: { userId: account.id, purpose, sessionVersion: account.sessionVersion, hash: { not: hash }, consumedAt: null }, data: { consumedAt: now() } });
        }
      }
      await tx.authEmailSend.update({ where: { id: reservation.id }, data: { status: "accepted" } });
    });
  }
  async function publicAttempt(operation: () => Promise<void>) {
    // Configuration failure is uniform, including requests for nonexistent accounts.
    accountEmailConfig(env);
    try { await operation(); }
    catch (error) {
      if (error instanceof AccountEmailError && ["EMAIL_RATE_LIMITED", "EMAIL_SEND_FAILED"].includes(error.code)) {
        console.warn("[account-email] " + error.code);
      } else throw error;
    }
    return { message: GENERIC_MESSAGE };
  }
  async function consume(rawToken: string, purpose: Purpose, nextPasswordHash?: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(rawToken)) throw new AccountEmailError("链接无效、已过期或已经使用，请重新申请邮件。", 400, "INVALID_TOKEN");
    const hash = digest(rawToken), timestamp = now();
    return retryTransaction(db, async tx => {
      const token = await tx.emailActionToken.findUnique({ where: { hash } });
      if (!token || token.purpose !== purpose || token.activeAt === null || token.consumedAt !== null || token.expiresAt <= timestamp) throw new AccountEmailError("链接无效、已过期或已经使用，请重新申请邮件。", 400, "INVALID_TOKEN");
      const claimed = await tx.emailActionToken.updateMany({ where: { hash, purpose, activeAt: { not: null }, consumedAt: null, expiresAt: { gt: timestamp } }, data: { consumedAt: timestamp } });
      if (claimed.count !== 1) throw new AccountEmailError("链接无效、已过期或已经使用，请重新申请邮件。", 400, "INVALID_TOKEN");
      if (purpose === "verify-email") {
        const updated = await tx.user.updateMany({ where: { id: token.userId, sessionVersion: token.sessionVersion }, data: { emailVerifiedAt: new Date(timestamp), requiresEmailVerification: false } });
        if (updated.count !== 1) throw new AccountEmailError("链接无效、已过期或已经使用，请重新申请邮件。", 400, "INVALID_TOKEN");
      } else {
        const passwordHash = purpose === "change-password" ? token.passwordHash : nextPasswordHash;
        if (!passwordHash) throw new AccountEmailError("链接无效、已过期或已经使用，请重新申请邮件。", 400, "INVALID_TOKEN");
        const updated = await tx.user.updateMany({ where: { id: token.userId, sessionVersion: token.sessionVersion }, data: { passwordHash, sessionVersion: { increment: 1 }, emailVerifiedAt: new Date(timestamp), requiresEmailVerification: false } });
        if (updated.count !== 1) throw new AccountEmailError("链接无效、已过期或已经使用，请重新申请邮件。", 400, "INVALID_TOKEN");
        await tx.emailActionToken.updateMany({ where: { userId: token.userId, consumedAt: null }, data: { consumedAt: timestamp } });
      }
      return { message: purpose === "verify-email" ? "邮箱已验证，请登录。" : "密码已修改，请使用新密码重新登录。", ...(purpose === "verify-email" ? { callbackUrl: safeEmailCallback(token.callbackUrl) } : {}) };
    });
  }
  return {
    register: (email: string, password: string, callbackUrl?: string) => publicAttempt(async () => {
      // Always compute the hash so account-existence is not exposed by hashing time.
      const passwordHash = await hashPassword(password);
      let account = await findAccount(email);
      if (!account) {
        try {
          account = await db.user.create({ data: { email: normalizedEmail(email), passwordHash, requiresEmailVerification: true } });
        } catch (error) {
          if (error && typeof error === "object" && "code" in error && error.code === "P2002") account = await findAccount(email);
          else throw error;
        }
      }
      if (account && !account.emailVerifiedAt) await sendAction(account, "verify-email", undefined, safeEmailCallback(callbackUrl));
    }),
    resendVerification: (email: string, callbackUrl?: string) => publicAttempt(async () => {
      const account = await findAccount(email);
      if (account && !account.emailVerifiedAt) await sendAction(account, "verify-email", undefined, safeEmailCallback(callbackUrl));
    }),
    forgotPassword: (email: string) => publicAttempt(async () => {
      const account = await findAccount(email);
      if (account) await sendAction(account, "reset-password");
    }),
    verifyEmail: (token: string) => consume(token, "verify-email"),
    resetPassword: async (token: string, password: string) => {
      // Reject unauthenticated random links before paying the scrypt cost. The
      // transaction below still rechecks and atomically consumes the token.
      const candidate = /^[A-Za-z0-9_-]{43}$/.test(token)
        ? await db.emailActionToken.findUnique({ where: { hash: digest(token) } }) : null;
      if (!candidate || candidate.purpose !== "reset-password" || candidate.activeAt === null || candidate.consumedAt !== null || candidate.expiresAt <= now()) {
        throw new AccountEmailError("链接无效、已过期或已经使用，请重新申请邮件。", 400, "INVALID_TOKEN");
      }
      return consume(token, "reset-password", await hashPassword(password));
    },
    changePassword: async (userId: string, currentPassword: string, password: string) => {
      accountEmailConfig(env);
      const account = await db.user.findUnique({ where: { id: userId } });
      if (!account) throw new AccountEmailError("请先登录。", 401, "UNAUTHORIZED");
      if (!await verifyPassword(currentPassword, account.passwordHash)) throw new AccountEmailError("当前密码不正确。", 400, "INVALID_PASSWORD");
      await sendAction(account, "change-password", await hashPassword(password));
      return { message: "修改密码的确认邮件已提交发送。请在邮箱中确认后使用新密码登录。" };
    },
    account: async (userId: string) => {
      const account = await db.user.findUnique({ where: { id: userId }, select: { email: true, emailVerifiedAt: true, requiresEmailVerification: true } });
      if (!account) throw new AccountEmailError("请先登录。", 401, "UNAUTHORIZED");
      return { email: account.email, emailVerified: Boolean(account.emailVerifiedAt), verificationRequired: account.requiresEmailVerification };
    },
    confirmPasswordChange: (token: string) => consume(token, "change-password"),
  };
}
export const accountEmailService = createAccountEmailService();
